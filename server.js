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

// --- 🚀 CONFIGURATION ---
const MARKET_ADDR = "0xE754F567272478B14f4dBc360a0F25B1DFa52dA3"; // Your Latest Contract
const USDC_ADDR   = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // Native USDC
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Relayer Key (Pays Gas)

// POLYMARKET API KEYS
const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;

// CACHE
const USER_PROXY_CACHE = {};

// ABIs
const SAFE_ABI = parseAbi([
    "function nonce() view returns (uint256)",
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"
]);
const USDC_ABI = parseAbi([
    "function approve(address, uint256) external", 
    "function allowance(address, address) view returns (uint256)"
]);

// --- ROOT ROUTE ---
app.get('/', (req, res) => {
    res.send('PolyLoans Relayer is Active. 🚀');
});

// --- HELPER: AUTH HEADERS ---
function getAuthHeaders(method, path, body = "") {
    if (!API_KEY || !API_SECRET || !API_PASSPHRASE) return {};
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method + path + body;
    const signature = crypto.createHmac('sha256', API_SECRET).update(message).digest('base64');
    return { 
        'Poly-Api-Key': API_KEY, 
        'Poly-Api-Signature': signature, 
        'Poly-Timestamp': timestamp, 
        'Poly-Api-Passphrase': API_PASSPHRASE 
    };
}

// --- HELPER: RESOLVE PROXY ---
async function resolveProxy(userAddress) {
    if (USER_PROXY_CACHE[userAddress]) return USER_PROXY_CACHE[userAddress];
    
    // Check Hardcoded Backup first
    const PROXY_MAP = { "0x87ECEbbE008c66eE0a45b4F2051Fe8e17f9afc1D": "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7" };
    if (PROXY_MAP[userAddress]) return PROXY_MAP[userAddress];

    try {
        const url = `https://data-api.polymarket.com/positions?user=${userAddress}`;
        const res = await axios.get(url);
        if (res.data?.[0]?.proxyWallet) {
            USER_PROXY_CACHE[userAddress] = res.data[0].proxyWallet;
            return res.data[0].proxyWallet;
        }
    } catch (e) { console.error("Proxy lookup failed:", e.message); }
    
    // Fallback: If no proxy found, maybe the user IS the proxy (or it's a new wallet)
    return null;
}

// --- 1. GET NONCE (For Frontend Signing) ---
app.get('/get-nonce', async (req, res) => {
    const { user } = req.query;
    try {
        const proxy = await resolveProxy(user);
        if (!proxy) return res.status(400).json({ error: "No Proxy Found. Do you have a Polymarket account?" });

        const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
        const nonce = await client.readContract({ address: proxy, abi: SAFE_ABI, functionName: 'nonce' });
        
        res.json({ nonce: nonce.toString(), proxy });
    } catch (e) {
        res.status(500).json({ error: "Could not fetch nonce" });
    }
});

// --- 2. RELAY TRANSACTION (The Core) ---
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

// --- 3. PORTFOLIO SCANNER (With Prices) ---
app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    const proxy = await resolveProxy(user) || user; 
    
    try {
        // A. Get Positions
        const posRes = await axios.get(`https://data-api.polymarket.com/positions?user=${proxy}`);
        let positions = posRes.data.filter(p => Number(p.size) > 0.000001);

        // B. Get Live Prices
        const rich = await Promise.all(positions.map(async (p) => {
            try {
                const path = `/price?token_id=${p.asset}&side=sell`;
                const headers = getAuthHeaders("GET", path);
                const priceCall = await axios.get(`https://clob.polymarket.com${path}`, { headers });
                return { ...p, livePrice: priceCall.data.price };
            } catch(e) {
                return { ...p, livePrice: "0" }; 
            }
        }));
        res.json(rich);
    } catch (e) { res.json([]); }
});

// --- 4. MARKET INFO (Correct Link Fetcher) ---
app.get('/market-info', async (req, res) => {
    const { tokenId } = req.query;
    try {
        const gammaRes = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
        if(gammaRes.data && gammaRes.data.length > 0) {
            const m = gammaRes.data[0];
            // If the market is part of a larger event, slug might be on the event object, 
            // but usually market slug works or we construct it.
            res.json({ 
                title: m.question, 
                slug: m.slug || m.market_slug 
            });
        } else {
            res.json({ title: "Unknown Market", slug: "" });
        }
    } catch(e) { res.json({ title: "Error", slug: "" }); }
});

// --- 5. SPECIAL: REPAY (Checks USDC Approval) ---
// This endpoint is special because it checks allowance BEFORE asking user to sign
app.post('/repay-check', async (req, res) => {
    const { userAddress } = req.body;
    const proxy = await resolveProxy(userAddress);
    if (!proxy) return res.status(400).json({ error: "No Proxy" });

    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
    const allowance = await client.readContract({ address: USDC_ADDR, abi: USDC_ABI, functionName: 'allowance', args: [proxy, MARKET_ADDR] });

    if (allowance < 1000000000n) {
        // We need to send an Approve TX first
        console.log("⚠️ Proxy needs to Approve USDC for Repayment.");
        // In a perfect world, we'd return a flag to frontend to sign an "Approve" tx first.
        // For simplicity in this demo, the Relayer forces it if it has the owner key (Self-Lending),
        // OR returns "Needs Approval" status.
        
        // AUTO-APPROVE (Only works if you are the Relayer AND the Owner, useful for testing)
        // If real users, frontend must sign "Approve" first.
        await forceApproveUSDC(proxy);
        res.json({ status: "Approved" });
    } else {
        res.json({ status: "Ready" });
    }
});

// --- INTERNAL HELPERS ---

async function forceApproveUSDC(proxyAddr) {
    // Only works if PRIVATE_KEY owns the Proxy (Test Mode)
    try {
        const account = privateKeyToAccount(PRIVATE_KEY);
        const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
        const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
        
        const data = encodeFunctionData({ abi: USDC_ABI, functionName: 'approve', args: [MARKET_ADDR, 115792089237316195423570985008687907853269984665640564039457584007913129639935n] });
        const nonce = await client.readContract({ address: proxyAddr, abi: SAFE_ABI, functionName: 'nonce' });
        
        // EIP-712 Sign
        const domain = { chainId: 137, verifyingContract: proxyAddr };
        const types = { SafeTx: [{name:"to",type:"address"},{name:"value",type:"uint256"},{name:"data",type:"bytes"},{name:"operation",type:"uint8"},{name:"safeTxGas",type:"uint256"},{name:"baseGas",type:"uint256"},{name:"gasPrice",type:"uint256"},{name:"gasToken",type:"address"},{name:"refundReceiver",type:"address"},{name:"nonce",type:"uint256"}] };
        const message = { to: USDC_ADDR, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce };
        const signature = await wallet.signTypedData({ domain, types, primaryType: 'SafeTx', message });
        
        const hash = await wallet.writeContract({ address: proxyAddr, abi: SAFE_ABI, functionName: 'execTransaction', args: [message.to, message.value, message.data, message.operation, message.safeTxGas, message.baseGas, message.gasPrice, message.gasToken, message.refundReceiver, signature] });
        console.log(`   ✅ Auto-Approved USDC: ${hash}`);
        await new Promise(r => setTimeout(r, 4000));
    } catch(e) { console.error("Auto-Approve Failed (User must sign manually)"); }
}

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