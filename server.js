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

// --- 🚀 CONFIGURATION ---
const MARKET_ADDR = "0x4081877663166Ff17d3fE690f271b329a2ed58eE"; 
const USDC_ADDR   = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // Native USDC
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Relayer Key (Pays Gas)

// POLYMARKET API
const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;

const SAFE_ABI = parseAbi(["function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)", "function nonce() view returns (uint256)"]);
// Simple mapping for now
const PROXY_MAP = { "0x87ECEbbE008c66eE0a45b4F2051Fe8e17f9afc1D": "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7" };

// --- 1. GET NONCE (Frontend needs this to sign) ---
app.get('/get-nonce', async (req, res) => {
    const { user } = req.query;
    // Fallback: If user has no proxy mapped, assume they are the proxy (for standard wallets)
    const proxy = PROXY_MAP[user] || user; 
    try {
        const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
        const nonce = await client.readContract({ address: proxy, abi: SAFE_ABI, functionName: 'nonce' });
        res.json({ nonce: nonce.toString(), proxy });
    } catch (e) { res.status(500).json({ error: "Could not fetch nonce. Is this a Safe?" }); }
});

// --- 2. RELAY TRANSACTION (Requires User Signature) ---
app.post('/relay-tx', async (req, res) => {
    const { proxy, to, data, signature } = req.body;
    try {
        console.log(`🚀 Relaying Tx for Proxy: ${proxy}`);
        const hash = await sendSafeTx(proxy, to, data, signature);
        console.log(`✅ Tx Hash: ${hash}`);
        res.json({ success: true, txHash: hash });
    } catch (e) {
        console.error("❌ Relay Failed:", e.message);
        res.status(500).json({ error: e.message || "Relay failed" });
    }
});

// --- 3. DATA ENDPOINTS ---
function getAuthHeaders(method, path) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const crypto = require('crypto');
    const signature = crypto.createHmac('sha256', API_SECRET).update(timestamp + method + path).digest('base64');
    return { 'Poly-Api-Key': API_KEY, 'Poly-Api-Signature': signature, 'Poly-Timestamp': timestamp, 'Poly-Api-Passphrase': API_PASSPHRASE };
}

app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    const proxy = PROXY_MAP[user] || user; 
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

async function sendSafeTx(safeAddr, to, data, userSignature) {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
    const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });

    return await wallet.writeContract({
        address: safeAddr, abi: SAFE_ABI, functionName: 'execTransaction',
        args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", userSignature]
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Relayer running on port ${PORT}`));