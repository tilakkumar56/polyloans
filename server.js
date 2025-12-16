const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// CONFIG
const MARKET_ADDR = "0xe5D387e0135dab4D722838DA348e6f51E9C871Af"; 
const USDC_ADDR = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; 
const PRIVATE_KEY = process.env.PRIVATE_KEY; 
const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;

const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)", "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"]);
const PROXY_MAP = { "0x87ecebbe008c66ee0a45b4f2051fe8e17f9afc1d": "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7" };

// 🔥 MANUAL OVERRIDES 🔥
const MANUAL_TITLES = {
    "111165": "My Test Asset (Manual Override)", // Will match your ID starting with 111165
    "217426": "Trump Win 2024" 
};

async function fetchMarketTitle(tokenId) {
    if (!tokenId || tokenId === "0") return "INVALID ID (0)";
    
    const idStr = tokenId.toString();

    // 1. CHECK MANUAL OVERRIDE (Strict 'Starts With')
    for (const [key, val] of Object.entries(MANUAL_TITLES)) {
        if (idStr.startsWith(key)) return val;
    }

    try {
        // Strategy 1: Gamma API
        const r = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
        if (r.data && r.data.length > 0) return r.data[0].question;

        // Strategy 2: CLOB API
        const r2 = await axios.get(`https://gamma-api.polymarket.com/markets?clob_token_id=${tokenId}`);
        if (r2.data && r2.data.length > 0) return r2.data[0].question;

        return `Unknown Asset (ID: ${tokenId.slice(0,6)}...)`;
    } catch (e) {
        return `Unknown Asset (ID: ${tokenId.slice(0,6)}...)`;
    }
}

// --- ENDPOINTS ---
app.get('/', (req, res) => res.send('PolyLoans Relayer Active'));

app.get('/market-info', async (req, res) => {
    const title = await fetchMarketTitle(req.query.tokenId);
    res.json({ title: title, slug: "" });
});

// ... [REST OF STANDARD FUNCTIONS] ...
// Copying crucial backend logic to ensure file is complete

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

app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    if(!user) return res.json([]);
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

function getAuthHeaders(method, path) {
    if (!API_KEY) return {};
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = crypto.createHmac('sha256', API_SECRET).update(ts + method + path).digest('base64');
    return { 'Poly-Api-Key': API_KEY, 'Poly-Api-Signature': sig, 'Poly-Timestamp': ts, 'Poly-Api-Passphrase': API_PASSPHRASE };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));