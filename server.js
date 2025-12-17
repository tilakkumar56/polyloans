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

// 🔥 MANUAL OVERRIDES 🔥
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
        // Strategy 1: CLOB IDs
        let r = await axios.get(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`);
        if (r.data && r.data.length > 0) return { title: r.data[0].question, slug: r.data[0].slug };

        // Strategy 2: Standard IDs
        r = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
        if (r.data && r.data.length > 0) return { title: r.data[0].question, slug: r.data[0].slug };

        // Strategy 3: Graph Fallback (Title Only usually, try to get slug)
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

app.get('/market-info', async (req, res) => {
    const data = await fetchMarketData(req.query.tokenId);
    res.json(data);
});

// ... [KEEP ALL OTHER ENDPOINTS (get-nonce, relay-tx, portfolio, etc.) EXACTLY THE SAME] ...
// I am omitting the standard boilerplate to save space, but DO NOT DELETE the other endpoints!
// Just verify you pasted the `fetchMarketData` and `/market-info` changes above.

// (If you need the full file again, tell me, but this change is small enough to merge if you know how. 
// If not, I can paste the full 150 lines again.)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));