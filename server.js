const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, toHex } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// 🔥 UPDATED CONTRACT ADDRESS 🔥
const MARKET_ADDR = "0xc22E31721eFB50aDe758F41371d11d27B9402C7c"; 

const USDC_ADDR = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; 
const PRIVATE_KEY = process.env.PRIVATE_KEY; 
const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;

const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)", "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"]);

// --- 🔥 ROBUST MARKET LOOKUP 🔥 ---
async function fetchMarketTitle(tokenId) {
    if (!tokenId || tokenId === "0") return "INVALID ID (0)";

    try {
        // Strategy 1: CLOB Token IDs (Plural - The Fix)
        let r = await axios.get(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`);
        if (r.data && r.data.length > 0) return r.data[0].question;

        // Strategy 2: Standard Token ID
        r = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
        if (r.data && r.data.length > 0) return r.data[0].question;

        // Strategy 3: The Graph (Deep Search)
        const hexId = toHex(BigInt(tokenId)); 
        const query = `
        {
            questions(where: {id: "${hexId}"}) { title }
            fixedProductMarketMakers(where: {collateralToken: "${hexId}"}) { title }
            conditions(where: {id: "${hexId}"}) { questionId }
        }
        `;
        const graphRes = await axios.post('https://api.thegraph.com/subgraphs/name/polymarket/matic-markets-6', { query });
        const data = graphRes.data.data;

        if (data.questions && data.questions.length > 0) return data.questions[0].title;
        if (data.fixedProductMarketMakers && data.fixedProductMarketMakers.length > 0) return data.fixedProductMarketMakers[0].title;
        
        if (data.conditions && data.conditions.length > 0) {
             const qId = data.conditions[0].questionId;
             const qRes = await axios.post('https://api.thegraph.com/subgraphs/name/polymarket/matic-markets-6', { 
                 query: `{ questions(where: {id: "${qId}"}) { title } }` 
             });
             if (qRes.data.data.questions.length > 0) return qRes.data.data.questions[0].title;
        }

        return `Unknown Asset (ID: ${tokenId.slice(0,6)}...)`;

    } catch (e) {
        return `Unknown Asset (ID: ${tokenId.slice(0,6)}...)`;
    }
}

// --- ENDPOINTS ---
app.get('/', (req, res) => res.send('PolyLoans Relayer Active'));

app.get('/market-info', async (req, res) => {
    const title = await fetchMarketTitle(req.query.tokenId);
    res.json({ title: title, slug: "" });
});

async function resolveProxy(user, manualProxy) {
    if (manualProxy && manualProxy.startsWith("0x") && manualProxy.length === 42) {
        console.log(`✅ Using Manual Proxy: ${manualProxy}`);
        return manualProxy.toLowerCase();
    }

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

    // Strategy 3: Gnosis Safe Registry (With Headers)
    try {
        const r = await axios.get(`https://safe-transaction-polygon.safe.global/api/v1/owners/${u}/safes/`, {
            headers: { 'User-Agent': 'Mozilla/5.0' } // Anti-block
        });
        if (r.data?.safes?.length > 0) {
            console.log(`✅ Proxy Found (Safe Registry): ${r.data.safes[0]}`);
            return r.data.safes[0].toLowerCase();
        }
    } catch(e) { console.log("Gnosis Registry lookup failed"); }

    console.log("❌ No Proxy Found via Auto-Discovery.");
    return null;
}

app.get('/get-nonce', async (req, res) => {
    const { user, proxy: manualProxy } = req.query;
    try {
        const proxy = await resolveProxy(user, manualProxy);
        if(!proxy) return res.status(404).json({ error: "No Proxy Found" });
        const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
        const nonce = await client.readContract({ address: proxy, abi: SAFE_ABI, functionName: 'nonce' });
        res.json({ nonce: nonce.toString(), proxy });
    } catch (e) { res.status(500).json({ error: "Nonce Error" }); }
});

app.post('/relay-tx', async (req, res) => {
    const { proxy, to, data, signature } = req.body;
    try {
        const hash = await sendSafeTx(proxy, to, data, signature);
        res.json({ success: true, txHash: hash });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/portfolio', async (req, res) => {
    const { user, proxy: manualProxy } = req.query;
    if(!user) return res.json([]);

    const userLower = user.toLowerCase();
    const targets = new Set([userLower]);
    
    // Resolve Proxy (Auto or Manual)
    const proxy = await resolveProxy(userLower, manualProxy);
    if(proxy) targets.add(proxy.toLowerCase());

    console.log(`🔎 Scanning Targets: ${Array.from(targets).join(', ')}`);

    let allPos = [];
    for(const t of targets) {
        try {
            const r = await axios.get(`https://data-api.polymarket.com/positions?user=${t}`);
            if(Array.isArray(r.data)) allPos.push(...r.data);
        } catch(e) {}
    }

    const valid = allPos.filter(p => Number(p.size) > 0.01);
    
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

async function sendSafeTx(safeAddr, to, data, userSignature) {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });

    return await wallet.writeContract({
        address: safeAddr, abi: SAFE_ABI, functionName: 'execTransaction',
        args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", userSignature],
        gas: 500000n
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));