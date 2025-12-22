const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createPublicClient, createWalletClient, http, parseAbi, toHex } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// 🔥 CONTRACT ADDRESS 🔥
const MARKET_ADDR = "0x9Edef523B68616380d16fA1052642b469F4C5A7E"; 
const PRIVATE_KEY = process.env.PRIVATE_KEY; 
const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;

const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)", "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"]);

// --- HELPERS ---
async function fetchMarketTitle(tokenId) {
    if (!tokenId || tokenId === "0") return "INVALID ID";
    try {
        let r = await axios.get(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`);
        if (r.data && r.data.length > 0) return r.data[0].question;
        r = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
        if (r.data && r.data.length > 0) return r.data[0].question;
        return `Unknown Asset (ID: ${tokenId.slice(0,6)}...)`;
    } catch { return `Unknown Asset`; }
}

async function resolveProxy(user) {
    if (!user) return null;
    const u = user.toLowerCase();
    
    // 1. Try Gamma User Profile (Most reliable for Polymarket)
    try {
        const r = await axios.get(`https://gamma-api.polymarket.com/users/${u}`);
        if (r.data?.proxyWallet) return r.data.proxyWallet.toLowerCase();
    } catch(e) {}

    // 2. Try NEW Gnosis Safe API (Polygon)
    try {
        const r = await axios.get(`https://api.safe.global/tx-service/pol/api/v1/owners/${u}/safes/`);
        if (r.data?.safes && r.data.safes.length > 0) return r.data.safes[0].toLowerCase();
    } catch(e) {}
    
    return null;
}

// --- ENDPOINTS ---
app.get('/', (req, res) => res.send('PolyLoans API Online'));

app.get('/market-info', async (req, res) => {
    const title = await fetchMarketTitle(req.query.tokenId);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    res.json({ title, slug });
});

app.get('/get-nonce', async (req, res) => {
    try {
        let proxy = req.query.proxy;
        if (!proxy) proxy = await resolveProxy(req.query.user);
        
        if (!proxy) return res.status(404).json({ error: "No Proxy Found" });
        
        const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
        const nonce = await client.readContract({ address: proxy, abi: SAFE_ABI, functionName: 'nonce' });
        res.json({ nonce: nonce.toString(), proxy });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/relay-tx', async (req, res) => {
    try {
        const { proxy, to, data, signature } = req.body;
        const account = privateKeyToAccount(PRIVATE_KEY);
        const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
        const hash = await wallet.writeContract({
            address: proxy, abi: SAFE_ABI, functionName: 'execTransaction',
            args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", signature],
            gas: 500000n
        });
        res.json({ success: true, txHash: hash });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 🔥 SUPER ROBUST SCANNER 🔥
app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    if (!user) return res.json([]);
    
    // Scan User AND Proxy
    const targets = new Set();
    targets.add(user.toLowerCase());
    
    const proxy = await resolveProxy(user);
    if (proxy) targets.add(proxy);

    console.log(`🔎 Scanning Targets: ${Array.from(targets).join(', ')}`);

    let allPos = [];
    for (const t of targets) {
        try {
            // Method A: Data API (Corrected URL)
            const r1 = await axios.get(`https://data-api.polymarket.com/positions?user=${t}&sizeThreshold=0&limit=50`);
            if (Array.isArray(r1.data)) allPos.push(...r1.data);
        } catch(e) {}

        try {
            // Method B: Gamma API (Fallback)
            const r2 = await axios.get(`https://gamma-api.polymarket.com/positions?user=${t}`);
            if (Array.isArray(r2.data)) allPos.push(...r2.data);
        } catch(e) {}
    }

    // Deduplicate by Asset ID
    const uniquePos = allPos.reduce((acc, current) => {
        const x = acc.find(item => item.asset === current.asset);
        if (!x) return acc.concat([current]);
        return acc;
    }, []);

    console.log(`✅ Found ${uniquePos.length} unique assets`);

    const rich = await Promise.all(uniquePos.map(async (p) => {
        if(Number(p.size) < 0.000001) return null; // Filter true zero
        try {
            const ts = Math.floor(Date.now() / 1000).toString();
            const path = `/price?token_id=${p.asset}&side=sell`;
            const sig = crypto.createHmac('sha256', API_SECRET).update(ts + "GET" + path).digest('base64');
            const headers = { 'Poly-Api-Key': API_KEY, 'Poly-Api-Signature': sig, 'Poly-Timestamp': ts, 'Poly-Api-Passphrase': API_PASSPHRASE };
            
            const r = await axios.get(`https://clob.polymarket.com${path}`, { headers });
            return { ...p, livePrice: r.data.price };
        } catch { return { ...p, livePrice: "0.50" }; } 
    }));

    res.json(rich.filter(p => p !== null));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));