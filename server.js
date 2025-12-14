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

// CONFIG
const MARKET_ADDR = "0x30672b8B427BD7277c8467221441e2D3Dbf833E4"; 
const USDC_ADDR = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; 
const PRIVATE_KEY = process.env.PRIVATE_KEY; 

const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;

const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)", "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"]);
const MARKET_ABI = parseAbi(["function createRequest(uint256, uint256, uint256, uint256) external returns (uint256)", "function acceptOffer(uint256) external", "function repayLoan(uint256) external", "function liquidateByTime(uint256) external", "function cancelOffer(uint256) external", "function cancelRequest(uint256) external"]);
const USDC_ABI = parseAbi(["function approve(address, uint256) external", "function allowance(address, address) view returns (uint256)"]);

// PROXY RESOLVER
const PROXY_MAP = { "0x87ecebbe008c66ee0a45b4f2051fe8e17f9afc1d": "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7" };

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

app.get('/', (req, res) => res.send('PolyLoans Relayer Active'));

// 1. NONCE
app.get('/get-nonce', async (req, res) => {
    const { user } = req.query;
    try {
        const proxy = await resolveProxy(user);
        if(!proxy) return res.status(404).json({ error: "No Proxy" });
        const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
        const nonce = await client.readContract({ address: proxy, abi: SAFE_ABI, functionName: 'nonce' });
        res.json({ nonce: nonce.toString(), proxy });
    } catch (e) { res.status(500).json({ error: "Nonce Error" }); }
});

// 2. RELAY
app.post('/relay-tx', async (req, res) => {
    const { proxy, to, data, signature } = req.body;
    try {
        console.log(`🚀 Relaying for ${proxy}...`);
        const hash = await sendSafeTx(proxy, to, data, signature);
        console.log(`✅ Hash: ${hash}`);
        res.json({ success: true, txHash: hash });
    } catch (e) {
        console.error("❌ Error:", e.shortMessage || e.message);
        res.status(500).json({ error: "Relay Failed" });
    }
});

// 3. CREATE REQUEST (Strict Validation)
app.post('/create-request', async (req, res) => {
    const { tokenId, shares, principal, duration, userAddress } = req.body;
    
    console.log("📝 Incoming Request ID:", tokenId); // LOG THE ID

    // 🔥 FIX: BLOCK ID 0
    if (!tokenId || tokenId === "0" || tokenId === 0) {
        console.error("❌ BLOCKED: Attempted to create request with Token ID 0");
        return res.status(400).json({ error: "Invalid Token ID (0). Select a valid asset." });
    }

    const sharesRaw = BigInt(Math.floor(Number(shares) * 1000000));
    const principalRaw = BigInt(Math.floor(Number(principal) * 1000000));
    const durationSec = BigInt(Number(duration) * 60); // Minutes -> Seconds

    await handleProxyTx(res, userAddress, MARKET_ADDR, MARKET_ABI, 'createRequest', [BigInt(tokenId), sharesRaw, principalRaw, durationSec]);
});

// 4. PORTFOLIO
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
        const resPos = await axios.get(`https://data-api.polymarket.com/positions?user=${proxy}`);
        let positions = resPos.data.filter(p => Number(p.size) > 0.000001);
        const rich = await Promise.all(positions.map(async (p) => {
            try {
                const path = `/price?token_id=${p.asset}&side=sell`;
                const prRes = await axios.get(`https://clob.polymarket.com${path}`, { headers: getAuthHeaders("GET", path) });
                return { ...p, livePrice: prRes.data.price, slug: p.slug };
            } catch(e) { return { ...p, livePrice: "0.50" }; }
        }));
        res.json(rich);
    } catch (e) { res.json([]); }
});

app.get('/market-info', async (req, res) => {
    try {
        // 🔥 FIX: If ID is 0, return explicit error
        if(req.query.tokenId === "0") return res.json({ title: "INVALID TOKEN ID 0", slug: "" });

        const r = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${req.query.tokenId}`);
        const m = r.data[0];
        res.json(m ? { title: m.question, slug: m.slug } : { title: "Unknown", slug: "" });
    } catch { res.json({ title: "Error", slug: "" }); }
});

// HELPERS
app.post('/accept-offer', async (req, res) => {
    const { offerId, userAddress } = req.body;
    await handleProxyTx(res, userAddress, MARKET_ADDR, MARKET_ABI, 'acceptOffer', [BigInt(offerId)]);
});
app.post('/repay-loan', async (req, res) => {
    const { requestId, userAddress } = req.body;
    const proxy = await resolveProxy(userAddress);
    await checkAndApproveUSDC(proxy);
    await handleProxyTx(res, userAddress, MARKET_ADDR, MARKET_ABI, 'repayLoan', [BigInt(requestId)]);
});
app.post('/cancel-offer', async (req, res) => {
    const { offerId, userAddress } = req.body;
    await handleProxyTx(res, userAddress, MARKET_ADDR, MARKET_ABI, 'cancelOffer', [BigInt(offerId)]);
});
app.post('/cancel-request', async (req, res) => {
    const { requestId, userAddress } = req.body;
    await handleProxyTx(res, userAddress, MARKET_ADDR, MARKET_ABI, 'cancelRequest', [BigInt(requestId)]);
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
    const proxy = await resolveProxy(userAddress);
    if (!proxy) return res.status(400).json({error: "No Proxy"});
    try {
        const data = encodeFunctionData({ abi, functionName: funcName, args });
        const hash = await sendSafeTx(proxy, to, data);
        res.json({ success: true, txHash: hash });
    } catch (e) { res.status(500).json({ error: e.message }); }
}

async function sendSafeTx(safeAddr, to, data, userSignature = "0x") {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
    const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
    
    // Check if we need signature from frontend (for Relay endpoint)
    // If internal call (like approve), we sign ourselves. If relay, we use userSignature.
    // For this specific server structure, relay-tx passes signature. 
    // Internal calls pass nothing, so we must sign as owner (ONLY WORKS IF SERVER KEY IS OWNER).
    // Assuming server key is owner for internal calls:
    let finalSig = userSignature;
    if (userSignature === "0x") {
        const nonce = await client.readContract({ address: safeAddr, abi: SAFE_ABI, functionName: 'nonce' });
        const domain = { chainId: 137, verifyingContract: safeAddr };
        const types = { SafeTx: [{name:"to",type:"address"},{name:"value",type:"uint256"},{name:"data",type:"bytes"},{name:"operation",type:"uint8"},{name:"safeTxGas",type:"uint256"},{name:"baseGas",type:"uint256"},{name:"gasPrice",type:"uint256"},{name:"gasToken",type:"address"},{name:"refundReceiver",type:"address"},{name:"nonce",type:"uint256"}] };
        const message = { to, value: 0n, data, operation: 0, safeTxGas: 500000n, baseGas: 0n, gasPrice: 0n, gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce };
        finalSig = await wallet.signTypedData({ domain, types, primaryType: 'SafeTx', message });
    }

    return await wallet.writeContract({
        address: safeAddr, abi: SAFE_ABI, functionName: 'execTransaction',
        args: [to, 0n, data, 0, 500000n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", finalSig],
        gas: 500000n
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));