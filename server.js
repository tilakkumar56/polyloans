const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createPublicClient, createWalletClient, http, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Relayer Key (Pays Gas)

// POLYMARKET API KEYS (For Pricing)
const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;

const SAFE_ABI = parseAbi([
    "function nonce() view returns (uint256)",
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"
]);

// Hardcoded Proxy Map (Backup)
const PROXY_MAP = { 
    "0x87ECEbbE008c66eE0a45b4F2051Fe8e17f9afc1D": "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7" 
};

// --- ROOT ---
app.get('/', (req, res) => res.send('PolyLoans Relayer V2 Active 🚀'));

// --- HELPER: Resolve Proxy ---
async function resolveProxy(userAddress) {
    if (PROXY_MAP[userAddress]) return PROXY_MAP[userAddress];
    try {
        const url = `https://data-api.polymarket.com/positions?user=${userAddress}`;
        const res = await axios.get(url);
        if (res.data?.[0]?.proxyWallet) {
            return res.data[0].proxyWallet;
        }
    } catch (e) {}
    return null;
}

// --- 1. GET NONCE (Frontend needs this to sign) ---
app.get('/get-nonce', async (req, res) => {
    const { user } = req.query;
    try {
        const proxy = await resolveProxy(user) || user; // Fallback to user if no proxy found (unlikely for traders)
        
        const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
        const nonce = await client.readContract({ address: proxy, abi: SAFE_ABI, functionName: 'nonce' });
        
        res.json({ nonce: nonce.toString(), proxy });
    } catch (e) {
        console.error("Nonce Error:", e.message);
        res.status(500).json({ error: "Could not fetch nonce" });
    }
});

// --- 2. RELAY TRANSACTION (Accepts Signature) ---
app.post('/relay-tx', async (req, res) => {
    const { proxy, to, data, signature } = req.body;
    
    try {
        console.log(`🚀 Relaying Tx for Proxy: ${proxy}`);
        const hash = await sendSafeTx(proxy, to, data, signature);
        console.log(`✅ Tx Hash: ${hash}`);
        res.json({ success: true, txHash: hash });
    } catch (e) {
        console.error("❌ Relay Failed:", e.message);
        // Send detailed error back to frontend
        res.status(500).json({ success: false, error: e.message || "Relay failed" });
    }
});

// --- 3. PRICING API ---
function getAuthHeaders(method, path) {
    if (!API_KEY) return {};
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto.createHmac('sha256', API_SECRET).update(timestamp + method + path).digest('base64');
    return { 'Poly-Api-Key': API_KEY, 'Poly-Api-Signature': signature, 'Poly-Timestamp': timestamp, 'Poly-Api-Passphrase': API_PASSPHRASE };
}

app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    const proxy = await resolveProxy(user) || user; 
    try {
        const posRes = await axios.get(`https://data-api.polymarket.com/positions?user=${proxy}`);
        let positions = posRes.data.filter(p => Number(p.size) > 0.000001);
        const rich = await Promise.all(positions.map(async (p) => {
            try {
                const path = `/price?token_id=${p.asset}&side=sell`;
                const priceCall = await axios.get(`https://clob.polymarket.com${path}`, { headers: getAuthHeaders("GET", path) });
                return { ...p, livePrice: priceCall.data.price, slug: p.slug };
            } catch(e) { return { ...p, livePrice: "0" }; }
        }));
        res.json(rich);
    } catch (e) { res.json([]); }
});

app.get('/market-info', async (req, res) => {
    try {
        const resG = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${req.query.tokenId}`);
        res.json(resG.data[0] ? { title: resG.data[0].question, slug: resG.data[0].slug } : { title: "Unknown", slug: "" });
    } catch(e) { res.json({ title: "Error", slug: "" }); }
});

// --- INTERNAL: SEND TX ON CHAIN ---
async function sendSafeTx(safeAddr, to, data, userSignature) {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
    const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });

    return await wallet.writeContract({
        address: safeAddr,
        abi: SAFE_ABI,
        functionName: 'execTransaction',
        args: [
            to, 
            0n, // Value
            data, 
            0, // Operation (Call)
            0n, 0n, 0n, // Gas params (0 = auto)
            "0x0000000000000000000000000000000000000000", // Gas Token
            "0x0000000000000000000000000000000000000000", // Refund Receiver
            userSignature 
        ]
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Relayer running on port ${PORT}`));