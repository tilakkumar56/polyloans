const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createPublicClient, http, parseAbi, toHex } = require('viem');
const { polygon } = require('viem/chains');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// CONFIG
const MARKET_ADDR = "0xe5D387e0135dab4D722838DA348e6f51E9C871Af"; 
const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)", "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"]);
const PROXY_MAP = { "0x87ecebbe008c66ee0a45b4f2051fe8e17f9afc1d": "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7" };

// 🔥 MANUAL OVERRIDES (Instant Fix) 🔥
const MANUAL_DATA = {
    "111165": { title: "Will Donald Trump win the 2024 US Election?", slug: "will-donald-trump-win-the-2024-us-election" }
};

// --- 🔥 SMART FETCH (Title + Slug) 🔥 ---
async function fetchMarketData(tokenId) {
    if (!tokenId || tokenId === "0") return { title: "INVALID ID (0)", slug: "" };

    const idStr = tokenId.toString();
    for (const [key, val] of Object.entries(MANUAL_DATA)) {
        if (idStr.startsWith(key)) return val;
    }

    try {
        // Strategy 1: CLOB IDs (Plural Fix)
        let r = await axios.get(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`);
        if (r.data && r.data.length > 0) return { title: r.data[0].question, slug: r.data[0].slug };

        // Strategy 2: Standard IDs
        r = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
        if (r.data && r.data.length > 0) return { title: r.data[0].question, slug: r.data[0].slug };

        // Strategy 3: Graph Fallback
        const hexId = toHex(BigInt(tokenId)); 
        const query = `{ questions(where: {id: "${hexId}"}) { title, slug } }`;
        const graphRes = await axios.post('https://api.thegraph.com/subgraphs/name/polymarket/matic-markets-6', { query });
        if (graphRes.data?.data?.questions?.length > 0) {
            return { title: graphRes.data.data.questions[0].title, slug: graphRes.data.data.questions[0].slug };
        }

        return { title: `Unknown Asset (${tokenId.slice(0,6)}...)`, slug: "" };

    } catch (e) {
        return { title: `Unknown Asset (${tokenId.slice(0,6)}...)`, slug: "" };
    }
}

// --- ENDPOINTS ---
app.get('/', (req, res) => res.send('PolyLoans Relayer Active'));

app.get('/market-info', async (req, res) => {
    const data = await fetchMarketData(req.query.tokenId);
    res.json(data);
});

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

app.get('/get-nonce', async (req, res) => {
    const { user } = req.query;
    try {
        const proxy = await resolveProxy(user);
        if(!proxy) return res.status(404).json({ error: "No Proxy Found" });
        // Use a standard RPC if publicnode is flaky
        const client = createPublicClient({ chain: polygon, transport: http("https://polygon-rpc.com") });
        const nonce = await client.readContract({ address: proxy, abi: SAFE_ABI, functionName: 'nonce' });
        res.json({ nonce: nonce.toString(), proxy });
    } catch (e) { res.status(500).json({ error: "Nonce Error" }); }
});

app.post('/relay-tx', async (req, res) => {
    const { proxy, to, data, signature } = req.body;
    try {
        // Note: For production, you'd want a real relayer like Gelato or OpenZeppelin here.
        // This is a simplified direct-write relayer for demo purposes.
        const { privateKeyToAccount } = require('viem/accounts');
        const { createWalletClient } = require('viem');
        const account = privateKeyToAccount(process.env.PRIVATE_KEY);
        const client = createWalletClient({ account, chain: polygon, transport: http("https://polygon-rpc.com") });
        
        const hash = await client.writeContract({
            address: proxy, abi: SAFE_ABI, functionName: 'execTransaction',
            args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", signature],
            gas: 500000n
        });
        res.json({ success: true, txHash: hash });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/portfolio', async (req, res) => {
    const { user } = req.query;
    if(!user) return res.json([]);
    const proxy = await resolveProxy(user);
    const targets = new Set([user.toLowerCase()]);
    if(proxy) targets.add(proxy.toLowerCase());

    let allPos = [];
    for(const t of targets) {
        try {
            const r = await axios.get(`https://data-api.polymarket.com/positions?user=${t}`);
            if(Array.isArray(r.data)) allPos.push(...r.data);
        } catch(e) {}
    }
    // Filter out dust
    const valid = allPos.filter(p => Number(p.size) > 0.000001);
    
    // Enrich with Prices
    const rich = await Promise.all(valid.map(async (p) => {
        try {
            // Fetch price from CLOB
            const r = await axios.get(`https://clob.polymarket.com/price?token_id=${p.asset}&side=sell`);
            return { ...p, livePrice: r.data.price, slug: p.slug };
        } catch(e) { return { ...p, livePrice: "0.50", slug: "unknown" }; }
    }));
    res.json(rich);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));