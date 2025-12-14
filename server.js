const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// CONFIG
const MARKET_ADDR = "0x30672b8B427BD7277c8467221441e2D3Dbf833E4"; 
const PRIVATE_KEY = process.env.PRIVATE_KEY; 
const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;

const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)", "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"]);
const PROXY_MAP = { "0x87ecebbe008c66ee0a45b4f2051fe8e17f9afc1d": "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7" };

// --- HELPER: AUTH HEADERS ---
function getAuthHeaders(method, path) {
    if (!API_KEY) return {};
    const crypto = require('crypto');
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = crypto.createHmac('sha256', API_SECRET).update(ts + method + path).digest('base64');
    return { 'Poly-Api-Key': API_KEY, 'Poly-Api-Signature': sig, 'Poly-Timestamp': ts, 'Poly-Api-Passphrase': API_PASSPHRASE };
}

// --- HELPER: RESOLVE PROXY ---
async function resolveProxy(user) {
    if (!user) return null;
    const u = user.toLowerCase();
    if (PROXY_MAP[u]) return PROXY_MAP[u];
    try {
        const res = await axios.get(`https://data-api.polymarket.com/positions?user=${user}`);
        if (res.data?.[0]?.proxyWallet) return res.data[0].proxyWallet;
    } catch (e) {}
    return null;
}

app.get('/', (req, res) => res.send('PolyLoans Relayer Active'));

// 1. GET NONCE
app.get('/get-nonce', async (req, res) => {
    const { user } = req.query;
    try {
        const proxy = await resolveProxy(user);
        if (!proxy) return res.status(404).json({ error: "No Proxy Found" });
        const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
        const nonce = await client.readContract({ address: proxy, abi: SAFE_ABI, functionName: 'nonce' });
        res.json({ nonce: nonce.toString(), proxy });
    } catch (e) { res.status(500).json({ error: "Nonce Error" }); }
});

// 2. RELAY
app.post('/relay-tx', async (req, res) => {
    const { proxy, to, data, signature } = req.body;
    try {
        const hash = await sendSafeTx(proxy, to, data, signature);
        console.log(`✅ TX Sent: ${hash}`);
        res.json({ success: true, txHash: hash });
    } catch (e) { res.status(500).json({ error: "Relay Failed" }); }
});

// 3. PORTFOLIO (FIXED SCANNING)
app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    if(!user) return res.json([]);

    const proxy = await resolveProxy(user);
    
    // We create a Set to ensure we scan unique addresses (Wallet + Proxy)
    const targets = new Set([user.toLowerCase()]);
    if(proxy) targets.add(proxy.toLowerCase());

    console.log(`🔎 Scanning Assets for: ${Array.from(targets).join(" & ")}`);

    let allPositions = [];

    // Loop through both addresses safely
    for(const t of targets) {
        try {
            const r = await axios.get(`https://data-api.polymarket.com/positions?user=${t}`);
            if(Array.isArray(r.data)) allPositions.push(...r.data);
        } catch(e) { console.error(`Failed scan for ${t}`); }
    }

    // Filter valid shares (> 0.000001)
    const valid = allPositions.filter(p => Number(p.size) > 0.000001);
    
    // Enrich with Prices
    const rich = await Promise.all(valid.map(async (p) => {
        try {
            const path = `/price?token_id=${p.asset}&side=sell`;
            const prRes = await axios.get(`https://clob.polymarket.com${path}`, { headers: getAuthHeaders("GET", path) });
            return { ...p, livePrice: prRes.data.price, slug: p.slug };
        } catch(e) { return { ...p, livePrice: "0.50", slug: "unknown" }; }
    }));

    res.json(rich);
});

// 4. MARKET INFO (Block ID 0)
app.get('/market-info', async (req, res) => {
    if(req.query.tokenId === "0") return res.json({ title: "INVALID TOKEN (ID 0)", slug: "" });
    try {
        const r = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${req.query.tokenId}`);
        const m = r.data[0];
        res.json(m ? { title: m.question, slug: m.slug } : { title: "Unknown", slug: "" });
    } catch { res.json({ title: "Error Fetching Info", slug: "" }); }
});

async function sendSafeTx(safeAddr, to, data, userSignature) {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
    const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
    
    // Force 500k Gas to bypass simulation issues
    return await wallet.writeContract({
        address: safeAddr, abi: SAFE_ABI, functionName: 'execTransaction',
        args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", userSignature],
        gas: 500000n
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));