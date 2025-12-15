const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createPublicClient, http, parseAbi, encodeFunctionData } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// --- CONFIG ---
const MARKET_ADDR = "0x30672b8B427BD7277c8467221441e2D3Dbf833E4"; 
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;

const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)", "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"]);
const PROXY_MAP = { "0x87ecebbe008c66ee0a45b4f2051fe8e17f9afc1d": "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7" };

async function resolveProxy(user) {
    if(!user) return null;
    const u = user.toLowerCase();
    if(PROXY_MAP[u]) return PROXY_MAP[u];
    try {
        const res = await axios.get(`https://data-api.polymarket.com/positions?user=${user}`);
        if(res.data?.[0]?.proxyWallet) return res.data[0].proxyWallet;
    } catch(e) {}
    return null;
}

app.get('/', (req, res) => res.send('PolyLoans Relayer Active'));

// 1. GET NONCE
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

// 2. RELAY
app.post('/relay-tx', async (req, res) => {
    const { proxy, to, data, signature } = req.body;
    try {
        console.log(`🚀 Relaying for ${proxy}...`);
        const hash = await sendSafeTx(proxy, to, data, signature);
        console.log(`✅ Success: ${hash}`);
        res.json({ success: true, txHash: hash });
    } catch (e) {
        console.error("❌ Relay Error:", e.shortMessage || e.message);
        res.status(500).json({ error: "Relay Failed" });
    }
});

// 3. PREPARE TX
app.post('/prepare-tx', async (req, res) => {
    // ... (Keep existing prepare logic if used, or client side prepare is fine too) ...
    // For simplicity with your current frontend, we skip this if frontend builds it.
    // BUT frontend relies on get-nonce, so we are good.
    res.status(404).send("Use client-side prepare"); 
});

// 4. MARKET INFO (FIXED TITLE FETCHING)
app.get('/market-info', async (req, res) => {
    const { tokenId } = req.query;
    
    // Strict Filter
    if(tokenId === "0" || !tokenId) return res.json({ title: "INVALID ASSET (ID 0)", slug: "" });

    try {
        // Strategy A: Gamma API
        const r = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
        if (r.data && r.data.length > 0) {
            const m = r.data[0];
            return res.json({ 
                title: m.question || m.groupItemTitle, 
                slug: m.slug 
            });
        }

        // Strategy B: CLOB API (Backup)
        const r2 = await axios.get(`https://clob.polymarket.com/market/${tokenId}`);
        if(r2.data) {
            return res.json({
                title: r2.data.condition_id ? "Market Found (No Title)" : "Unknown",
                slug: ""
            });
        }

        res.json({ title: `Unknown Asset (${tokenId.slice(0,6)}...)`, slug: "" });

    } catch(e) {
        console.error(`Info Fetch Error for ${tokenId}:`, e.message);
        res.json({ title: "Error Fetching Title", slug: "" });
    }
});

// 5. PORTFOLIO
function getAuthHeaders(method, path) {
    if (!API_KEY) return {};
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = crypto.createHmac('sha256', API_SECRET).update(ts + method + path).digest('base64');
    return { 'Poly-Api-Key': API_KEY, 'Poly-Api-Signature': sig, 'Poly-Timestamp': ts, 'Poly-Api-Passphrase': API_PASSPHRASE };
}

app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    const proxy = await resolveProxy(user);
    const targets = new Set([user.toLowerCase()]);
    if(proxy) targets.add(proxy.toLowerCase());

    let allPos = [];
    for(const t of targets) {
        try {
            const r = await axios.get(`https://data-api.polymarket.com/positions?user=${t}`);
            if(Array.isArray(r.data)) allPos.push(...r.data);
        } catch(e) {}
    }

    const valid = allPos.filter(p => Number(p.size) > 0.000001);
    
    const rich = await Promise.all(valid.map(async (p) => {
        try {
            const path = `/price?token_id=${p.asset}&side=sell`;
            const prRes = await axios.get(`https://clob.polymarket.com${path}`, { headers: getAuthHeaders("GET", path) });
            return { ...p, livePrice: prRes.data.price, slug: p.slug };
        } catch(e) { return { ...p, livePrice: "0.50", slug: "unknown" }; }
    }));

    res.json(rich);
});

async function sendSafeTx(safeAddr, to, data, userSignature) {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
    const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });

    return await wallet.writeContract({
        address: safeAddr, abi: SAFE_ABI, functionName: 'execTransaction',
        args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", userSignature],
        gas: 500000n
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));