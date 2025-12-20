const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createPublicClient, http, parseAbi } = require('viem');
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

// --- 🔥 TITANIUM PROXY RESOLVER 🔥 ---
async function resolveProxy(user) {
    if(!user) return null;
    const u = user.toLowerCase();
    
    // Strategy 1: Gamma API (Best)
    try {
        const r = await axios.get(`https://gamma-api.polymarket.com/users/${u}`);
        if (r.data?.proxyWallet) {
            console.log(`✅ Proxy Found (Gamma): ${r.data.proxyWallet}`);
            return r.data.proxyWallet.toLowerCase();
        }
    } catch(e) {}

    // Strategy 2: Data API Activity (Fallback)
    try {
        const r = await axios.get(`https://data-api.polymarket.com/activity?user=${u}&limit=1`);
        if (Array.isArray(r.data) && r.data.length > 0 && r.data[0].proxyWallet) {
            console.log(`✅ Proxy Found (Activity): ${r.data[0].proxyWallet}`);
            return r.data[0].proxyWallet.toLowerCase();
        }
    } catch(e) {}

    console.log("❌ No Proxy Found (User might need to Log In to Polymarket.com once)");
    return null;
}

// --- ENDPOINTS ---
app.get('/', (req, res) => res.send('Titanium Scanner Online'));

app.get('/market-info', async (req, res) => {
    try {
        let r = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${req.query.tokenId}`);
        res.json({ title: r.data[0]?.question || "Unknown Asset", slug: "" });
    } catch { res.json({ title: "Unknown Asset", slug: "" }); }
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

// --- 🔥 UNIVERSAL SCANNER (DATA API) 🔥 ---
app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    if(!user) return res.json([]);

    const userLower = user.toLowerCase();
    const targets = new Set([userLower]); // Always scan Main Wallet
    
    // Try to find Proxy
    const proxy = await resolveProxy(userLower);
    if(proxy) targets.add(proxy.toLowerCase());

    console.log(`🔎 Scanning Targets: ${Array.from(targets).join(', ')}`);

    let allPos = [];
    
    // Scan both addresses using Official Data API
    for(const t of targets) {
        try {
            const r = await axios.get(`https://data-api.polymarket.com/positions?user=${t}`);
            if(Array.isArray(r.data)) allPos.push(...r.data);
        } catch(e) {
            console.log(`Failed to scan ${t}: ${e.message}`);
        }
    }

    // Filter Dust (< 0.01)
    const valid = allPos.filter(p => Number(p.size) > 0.01);
    console.log(`   -> Found ${valid.length} valid assets.`);

    // Enrich with Prices
    const rich = await Promise.all(valid.map(async (p) => {
        try {
            const path = `/price?token_id=${p.asset}&side=sell`;
            const prRes = await axios.get(`https://clob.polymarket.com${path}`, { 
                headers: API_KEY ? { 
                    'Poly-Api-Key': API_KEY, 
                    'Poly-Api-Signature': crypto.createHmac('sha256', API_SECRET).update(Math.floor(Date.now()/1000)+"GET"+path).digest('base64'), 
                    'Poly-Timestamp': Math.floor(Date.now()/1000), 
                    'Poly-Api-Passphrase': API_PASSPHRASE 
                } : {}
            });
            return { ...p, livePrice: prRes.data.price, slug: p.slug };
        } catch(e) { return { ...p, livePrice: "0.50", slug: "unknown" }; }
    }));
    
    res.json(rich);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));