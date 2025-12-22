const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
// 🔥 ADDED getAddress HERE 🔥
const { createPublicClient, createWalletClient, http, parseAbi, toHex, getAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const MARKET_ADDR = "0x9Edef523B68616380d16fA1052642b469F4C5A7E"; 
const PRIVATE_KEY = process.env.PRIVATE_KEY; 
const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;

const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)", "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"]);

// --- HELPERS ---
async function fetchMarketTitle(tokenId) {
    if (!tokenId) return "Unknown Asset";
    try {
        const r = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
        if (r.data?.[0]) return r.data[0].question;
        return `Asset ${tokenId.slice(0,6)}...`;
    } catch { return "Unknown Asset"; }
}

async function resolveProxy(user) {
    if (!user) return null;
    const u = user.toLowerCase();
    
    // 1. Try Gamma (Lowercase OK)
    try {
        const r = await axios.get(`https://gamma-api.polymarket.com/users/${u}`);
        if (r.data?.proxyWallet) return r.data.proxyWallet.toLowerCase();
    } catch(e) {}

    // 2. Try Gnosis (MUST BE CHECKSUMMED!)
    try {
        const checksumAddr = getAddress(u); // 🔥 FIX: Convert to Checksum
        const r = await axios.get(`https://api.safe.global/tx-service/pol/api/v1/owners/${checksumAddr}/safes/`);
        if (r.data?.safes?.length > 0) return r.data.safes[0].toLowerCase();
    } catch(e) {
        console.log("Gnosis Scan Error:", e.message);
    }
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

app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    if (!user) return res.json([]);
    
    const targets = [user.toLowerCase()];
    const proxy = await resolveProxy(user);
    if (proxy) targets.push(proxy);

    console.log(`Scanning: ${targets.join(', ')}`);
    
    let allPos = [];
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

    for (const t of targets) {
        try {
            const url = `https://data-api.polymarket.com/positions?user=${t}&sizeThreshold=0`;
            const r = await axios.get(url, { headers });
            if (Array.isArray(r.data)) allPos.push(...r.data);
        } catch(e) {}
    }

    const valid = allPos.filter(p => Number(p.size) > 0);
    // Deduplicate
    const unique = valid.reduce((acc, current) => {
        const x = acc.find(item => item.asset === current.asset);
        if (!x) return acc.concat([current]);
        return acc;
    }, []);

    const rich = await Promise.all(unique.map(async (p) => {
        try {
            const r = await axios.get(`https://clob.polymarket.com/price?token_id=${p.asset}&side=sell`);
            return { ...p, livePrice: r.data.price };
        } catch { return { ...p, livePrice: "0.50" }; }
    }));

    res.json(rich);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));