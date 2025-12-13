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

// --- UPDATE THIS AFTER DEPLOYING ---
const MARKET_ADDR = "0x59B3a47dBe8B251eB14E57509A15Ed829065B91e"; 
const USDC_ADDR = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; 
const PRIVATE_KEY = process.env.PRIVATE_KEY; 

// API KEYS
const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;

const SAFE_ABI = parseAbi([
    "function nonce() view returns (uint256)",
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"
]);

app.get('/', (req, res) => res.send('PolyLoans Relayer Active'));

// --- PROXY RESOLVER ---
const PROXY_CACHE = {};
async function resolveProxy(user) {
    if (PROXY_CACHE[user]) return PROXY_CACHE[user];
    // Hardcoded fallback for your specific wallet if API fails
    if(user.toLowerCase() === "0x87ecebbe008c66ee0a45b4f2051fe8e17f9afc1d") return "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7";
    
    try {
        const res = await axios.get(`https://data-api.polymarket.com/positions?user=${user}`);
        if (res.data?.[0]?.proxyWallet) {
            PROXY_CACHE[user] = res.data[0].proxyWallet;
            return res.data[0].proxyWallet;
        }
    } catch (e) { console.error("Proxy API Error:", e.message); }
    return null;
}

// --- 1. GET NONCE ---
app.get('/get-nonce', async (req, res) => {
    const { user } = req.query;
    try {
        const proxy = await resolveProxy(user);
        if (!proxy) return res.status(404).json({ error: "No Proxy Found. Trade on Polymarket first." });

        const client = createPublicClient({ chain: polygon, transport: http("https://polygon-rpc.com") });
        const nonce = await client.readContract({ address: proxy, abi: SAFE_ABI, functionName: 'nonce' });
        
        res.json({ nonce: nonce.toString(), proxy });
    } catch (e) {
        console.error("Nonce Error:", e.message);
        res.status(500).json({ error: "Failed to fetch nonce" });
    }
});

// --- 2. RELAY TRANSACTION ---
app.post('/relay-tx', async (req, res) => {
    const { proxy, to, data, signature } = req.body;
    try {
        console.log(`🚀 Relaying TX for ${proxy} -> ${to}`);
        const hash = await sendSafeTx(proxy, to, data, signature);
        console.log(`✅ TX Sent: ${hash}`);
        res.json({ success: true, txHash: hash });
    } catch (e) {
        console.error("❌ Relay Failed:", e.message);
        // The error message usually contains the revert reason
        res.status(500).json({ error: e.message || "Transaction Reverted on Chain" });
    }
});

// --- 3. MARKET INFO & PORTFOLIO ---
function getAuthHeaders(method, path) {
    if (!API_KEY) return {};
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = crypto.createHmac('sha256', API_SECRET).update(ts + method + path).digest('base64');
    return { 'Poly-Api-Key': API_KEY, 'Poly-Api-Signature': sig, 'Poly-Timestamp': ts, 'Poly-Api-Passphrase': API_PASSPHRASE };
}

app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    const proxy = await resolveProxy(user) || user;
    try {
        const pRes = await axios.get(`https://data-api.polymarket.com/positions?user=${proxy}`);
        let positions = pRes.data.filter(p => Number(p.size) > 0.000001);
        
        // Add Live Prices
        const rich = await Promise.all(positions.map(async (p) => {
            try {
                const path = `/price?token_id=${p.asset}&side=sell`;
                const prRes = await axios.get(`https://clob.polymarket.com${path}`, { headers: getAuthHeaders("GET", path) });
                return { ...p, livePrice: prRes.data.price, slug: p.slug };
            } catch(e) { return { ...p, livePrice: "0" }; }
        }));
        res.json(rich);
    } catch (e) { res.json([]); }
});

app.get('/market-info', async (req, res) => {
    try {
        const r = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${req.query.tokenId}`);
        const m = r.data[0];
        res.json(m ? { title: m.question, slug: m.slug } : { title: "Unknown", slug: "" });
    } catch { res.json({ title: "Error", slug: "" }); }
});

// --- INTERNAL: SEND TX ---
async function sendSafeTx(safeAddr, to, data, userSignature) {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-rpc.com") });
    const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-rpc.com") });

    // Manually set gas limit to avoid simulation failures during estimation
    return await wallet.writeContract({
        address: safeAddr, abi: SAFE_ABI, functionName: 'execTransaction',
        args: [to, 0n, data, 0, 500000n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", userSignature]
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Relayer running on ${PORT}`));