const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
// ✅ NEW MARKET ADDRESS
const MARKET_ADDR = "0xf8bF64E5c8f42002119B8Dbf516a9c5eD06cc2e5"; 
const USDC_ADDR = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; 
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// API CREDENTIALS
const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;

// PROXY MAP
const PROXY_MAP = { 
    "0x87ECEbbE008c66eE0a45b4F2051Fe8e17f9afc1D": "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7" 
};

// ABIs
const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)", "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"]);
const MARKET_ABI = parseAbi([
    "function createRequest(uint256, uint256, uint256, uint256) external returns (uint256)", 
    "function acceptOffer(uint256) external", 
    "function repayLoan(uint256) external",
    "function liquidateByTime(uint256) external",
    "function cancelOffer(uint256) external"
]);
const USDC_ABI = parseAbi(["function approve(address, uint256) external", "function allowance(address, address) view returns (uint256)"]);

// --- ROOT ROUTE (Fixes "Cannot GET /") ---
app.get('/', (req, res) => {
    res.send('PolyLend API is running. Access endpoints like /portfolio.');
});

// --- AUTH HELPER ---
function getAuthHeaders(method, path, body = "") {
    if (!API_KEY || !API_SECRET || !API_PASSPHRASE) return {};
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method + path + body;
    const signature = crypto.createHmac('sha256', API_SECRET).update(message).digest('base64');
    return { 'Poly-Api-Key': API_KEY, 'Poly-Api-Signature': signature, 'Poly-Timestamp': timestamp, 'Poly-Api-Passphrase': API_PASSPHRASE };
}

// 1. PORTFOLIO
app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    const proxy = PROXY_MAP[user] || user; 
    try {
        const posRes = await axios.get(`https://data-api.polymarket.com/positions?user=${proxy}`);
        let positions = posRes.data.filter(p => Number(p.size) > 0.000001);
        
        const richPositions = await Promise.all(positions.map(async (p) => {
            try {
                const path = `/price?token_id=${p.asset}&side=sell`;
                const headers = getAuthHeaders("GET", path);
                const priceCall = await axios.get(`https://clob.polymarket.com${path}`, { headers });
                return { ...p, livePrice: priceCall.data.price, slug: p.slug };
            } catch(e) { return { ...p, livePrice: "0" }; }
        }));
        res.json(richPositions);
    } catch (e) { res.json([]); }
});

// 2. MARKET INFO
app.get('/market-info', async (req, res) => {
    const { tokenId } = req.query;
    try {
        const gammaRes = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
        if(gammaRes.data && gammaRes.data.length > 0) {
            res.json({ title: gammaRes.data[0].question, slug: gammaRes.data[0].slug });
        } else { res.json({ title: "Unknown Market", slug: "" }); }
    } catch(e) { res.json({ title: "Error fetching info", slug: "" }); }
});

// 3. CREATE REQUEST
app.post('/create-request', async (req, res) => {
    const { tokenId, shares, principal, duration, userAddress } = req.body;
    await handleProxyTx(res, userAddress, MARKET_ADDR, MARKET_ABI, 'createRequest', [BigInt(tokenId), BigInt(Math.floor(Number(shares)*1000000)), BigInt(Math.floor(Number(principal)*1000000)), BigInt(Number(duration)*86400)]);
});

// 4. ACCEPT OFFER
app.post('/accept-offer', async (req, res) => {
    const { offerId, userAddress } = req.body;
    await handleProxyTx(res, userAddress, MARKET_ADDR, MARKET_ABI, 'acceptOffer', [BigInt(offerId)]);
});

// 5. REPAY
app.post('/repay-loan', async (req, res) => {
    const { requestId, userAddress } = req.body;
    const proxy = PROXY_MAP[userAddress] || userAddress; 
    await checkAndApproveUSDC(proxy);
    await handleProxyTx(res, userAddress, MARKET_ADDR, MARKET_ABI, 'repayLoan', [BigInt(requestId)]);
});

// 6. CANCEL
app.post('/cancel-offer', async (req, res) => {
    const { offerId, userAddress } = req.body;
    await handleProxyTx(res, userAddress, MARKET_ADDR, MARKET_ABI, 'cancelOffer', [BigInt(offerId)]);
});

async function checkAndApproveUSDC(proxyAddr) {
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
    const allowance = await client.readContract({ address: USDC_ADDR, abi: USDC_ABI, functionName: 'allowance', args: [proxyAddr, MARKET_ADDR] });
    if (allowance < 1000000000n) {
        await sendSafeTx(proxyAddr, USDC_ADDR, encodeFunctionData({ abi: USDC_ABI, functionName: 'approve', args: [MARKET_ADDR, 115792089237316195423570985008687907853269984665640564039457584007913129639935n] }));
        await new Promise(r => setTimeout(r, 4000));
    }
}

async function handleProxyTx(res, userAddress, to, abi, funcName, args) {
    const proxy = PROXY_MAP[userAddress];
    if (!proxy) return res.status(400).json({error: "No Proxy"});
    try {
        const hash = await sendSafeTx(proxy, to, encodeFunctionData({ abi, functionName: funcName, args }));
        res.json({ success: true, txHash: hash });
    } catch (e) { res.status(500).json({ error: e.message }); }
}

async function sendSafeTx(safeAddr, to, data) {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
    const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
    const nonce = await client.readContract({ address: safeAddr, abi: SAFE_ABI, functionName: 'nonce' });
    const message = { to, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce };
    const signature = await wallet.signTypedData({ domain: { chainId: 137, verifyingContract: safeAddr }, types: { SafeTx: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" }] }, primaryType: 'SafeTx', message });
    return await wallet.writeContract({ address: safeAddr, abi: SAFE_ABI, functionName: 'execTransaction', args: [message.to, message.value, message.data, message.operation, message.safeTxGas, message.baseGas, message.gasPrice, message.gasToken, message.refundReceiver, signature] });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));