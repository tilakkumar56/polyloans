const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createPublicClient, createWalletClient, http, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const MARKET_ADDR = "0x59B3a47dBe8B251eB14E57509A15Ed829065B91e";
const USDC_ADDR = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)", "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"]);

// --- ROOT ---
app.get('/', (req, res) => res.send('PolyLoans Relayer Active'));

// --- HELPER: Resolve Proxy ---
const PROXY_MAP = { "0x87ECEbbE008c66eE0a45b4F2051Fe8e17f9afc1D": "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7" };
async function resolveProxy(user) {
    if (PROXY_MAP[user]) return PROXY_MAP[user];
    try {
        const res = await axios.get(`https://data-api.polymarket.com/positions?user=${user}`);
        if (res.data?.[0]?.proxyWallet) return res.data[0].proxyWallet;
    } catch (e) {}
    return null;
}

// --- 1. GET NONCE ---
app.get('/get-nonce', async (req, res) => {
    const { user } = req.query;
    try {
        const proxy = await resolveProxy(user);
        if (!proxy) return res.status(404).json({ error: "No Proxy Found" });
        const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
        const nonce = await client.readContract({ address: proxy, abi: SAFE_ABI, functionName: 'nonce' });
        res.json({ nonce: nonce.toString(), proxy });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 2. RELAY ---
app.post('/relay-tx', async (req, res) => {
    const { proxy, to, data, signature } = req.body;
    try {
        console.log(`🚀 Relaying for ${proxy}...`);
        const hash = await sendSafeTx(proxy, to, data, signature);
        console.log(`✅ Success: ${hash}`);
        res.json({ success: true, txHash: hash });
    } catch (e) {
        console.error("❌ Relay Error:", e); // This prints the full error to Render Logs
        res.status(500).json({ error: e.shortMessage || e.message });
    }
});

// --- 3. DATA ---
app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    const proxy = await resolveProxy(user) || user; 
    try {
        const resPos = await axios.get(`https://data-api.polymarket.com/positions?user=${proxy}`);
        res.json(resPos.data.filter(p => Number(p.size) > 0.000001));
    } catch (e) { res.json([]); }
});

app.get('/market-info', async (req, res) => {
    try {
        const r = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${req.query.tokenId}`);
        const m = r.data[0];
        res.json(m ? { title: m.question, slug: m.slug } : { title: "Unknown", slug: "" });
    } catch { res.json({ title: "Error", slug: "" }); }
});

async function sendSafeTx(safeAddr, to, data, userSignature) {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
    const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });

    // FORCE GAS to prevent simulation failures
    return await wallet.writeContract({
        address: safeAddr, abi: SAFE_ABI, functionName: 'execTransaction',
        args: [to, 0n, data, 0, 500000n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", userSignature]
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));