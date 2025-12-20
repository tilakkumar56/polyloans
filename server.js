const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, toHex } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// CONFIG
const MARKET_ADDR = "0x08190EAE6A7497804C9315D8e46CB217e9a6244f"; 
const PRIVATE_KEY = process.env.PRIVATE_KEY; 
const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;

const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)", "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"]);

// --- 🔥 ROBUST PROXY RESOLVER 🔥 ---
async function resolveProxy(user) {
    if(!user) return null;
    const u = user.toLowerCase();
    try {
        // Method 1: Gamma API (Best)
        const r = await axios.get(`https://gamma-api.polymarket.com/users/${u}`);
        if (r.data && r.data.proxyWallet) {
            console.log(`✅ Found Proxy (Gamma): ${r.data.proxyWallet}`);
            return r.data.proxyWallet.toLowerCase();
        }
    } catch(e) { console.log("Gamma Proxy lookup failed, trying fallback..."); }

    return null;
}

// --- API LOOKUP ---
async function fetchMarketTitle(tokenId) {
    if (!tokenId || tokenId === "0") return "INVALID ID";
    try {
        let r = await axios.get(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`);
        if (r.data?.length > 0) return r.data[0].question;
        r = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
        if (r.data?.length > 0) return r.data[0].question;
        return `Unknown Asset`;
    } catch (e) { return `Unknown Asset`; }
}

// --- ENDPOINTS ---
app.get('/', (req, res) => res.send('PolyLoans Relayer Active'));

app.get('/market-info', async (req, res) => {
    const title = await fetchMarketTitle(req.query.tokenId);
    res.json({ title, slug: "" });
});

app.get('/get-nonce', async (req, res) => {
    const { user } = req.query;
    try {
        const proxy = await resolveProxy(user);
        if(!proxy) return res.status(404).json({ error: "No Proxy Found" });
        
        const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
        const nonce = await client.readContract({ address: proxy, abi: SAFE_ABI, functionName: 'nonce' });
        res.json({ nonce: nonce.toString(), proxy });
    } catch (e) { res.status(500).json({ error: "Nonce Error" }); }
});

app.post('/relay-tx', async (req, res) => {
    const { proxy, to, data, signature } = req.body;
    try {
        const hash = await sendSafeTx(proxy, to, data, signature);
        res.json({ success: true, txHash: hash });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 🔥 NUCLEAR OPTION PORTFOLIO SCANNER 🔥
app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    if(!user) return res.json([]);

    const userLower = user.toLowerCase();
    
    // 1. Always scan the EOA (Main Wallet)
    const targets = new Set([userLower]);
    
    // 2. Try to find Proxy and add it
    const proxy = await resolveProxy(userLower);
    if(proxy) targets.add(proxy.toLowerCase());

    console.log(`🔎 Scanning Addresses: ${Array.from(targets).join(', ')}`);

    let allPos = [];
    
    // 3. Scan BOTH addresses using Data API
    for(const t of targets) {
        try {
            console.log(`...fetching positions for ${t}`);
            const r = await axios.get(`https://data-api.polymarket.com/positions?user=${t}`);
            if(Array.isArray(r.data)) {
                console.log(`   -> Found ${r.data.length} raw positions`);
                allPos.push(...r.data);
            }
        } catch(e) {
            console.error(`Error scanning ${t}:`, e.message);
        }
    }

    // 4. Clean Data & Fetch Prices
    // Filter for size > 0.01 to ignore dust
    const valid = allPos.filter(p => Number(p.size) > 0.01);
    console.log(`✨ Valid Assets > 0.01: ${valid.length}`);

    const rich = await Promise.all(valid.map(async (p) => {
        try {
            // Fetch Price
            const path = `/price?token_id=${p.asset}&side=sell`;
            const prRes = await axios.get(`https://clob.polymarket.com${path}`, { headers: getAuthHeaders("GET", path) });
            return { ...p, livePrice: prRes.data.price, slug: p.slug };
        } catch(e) { 
            return { ...p, livePrice: "0.50", slug: "unknown" }; // Default price if fetch fails
        }
    }));
    
    res.json(rich);
});

async function sendSafeTx(safeAddr, to, data, userSignature) {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });

    return await wallet.writeContract({
        address: safeAddr, abi: SAFE_ABI, functionName: 'execTransaction',
        args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", userSignature],
        gas: 500000n
    });
}

function getAuthHeaders(method, path) {
    if (!API_KEY) return {};
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = crypto.createHmac('sha256', API_SECRET).update(ts + method + path).digest('base64');
    return { 'Poly-Api-Key': API_KEY, 'Poly-Api-Signature': sig, 'Poly-Timestamp': ts, 'Poly-Api-Passphrase': API_PASSPHRASE };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));