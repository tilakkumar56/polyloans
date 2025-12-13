const { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
require('dotenv').config();

// ⚠️ PASTE YOUR NEW MARKET ADDRESS HERE ⚠️
const MARKET_ADDR = "0x59B3a47dBe8B251eB14E57509A15Ed829065B91e"; 

// CONSTANTS
const PROXY_ADDR  = "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7"; // Your Proxy
const CTF_ADDR    = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // Polymarket CTF
const USDC_ADDR   = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // Native USDC
const PRIVATE_KEY = process.env.PRIVATE_KEY; // MUST BE THE OWNER OF THE PROXY

const SAFE_ABI = parseAbi([
    "function nonce() view returns (uint256)", 
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"
]);
const CTF_ABI = parseAbi(["function setApprovalForAll(address, bool) external"]);
const USDC_ABI = parseAbi(["function approve(address, uint256) external"]);

async function main() {
    if(!PRIVATE_KEY) throw new Error("Check .env file for PRIVATE_KEY");

    const account = privateKeyToAccount(PRIVATE_KEY);
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-rpc.com") });
    const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-rpc.com") });

    console.log(`🔐 Authorizing Market: ${MARKET_ADDR}`);
    console.log(`👤 Proxy: ${PROXY_ADDR}`);

    // 1. Get Nonce
    const nonce = await client.readContract({ address: PROXY_ADDR, abi: SAFE_ABI, functionName: 'nonce' });
    console.log(`🔹 Current Nonce: ${nonce}`);

    // 2. Approve CTF (Shares)
    console.log("👉 1/2: Approving Share Transfers (CTF)...");
    const dataCTF = encodeFunctionData({ abi: CTF_ABI, functionName: 'setApprovalForAll', args: [MARKET_ADDR, true] });
    await sendSafeTx(wallet, PROXY_ADDR, CTF_ADDR, dataCTF, nonce);

    // 3. Approve USDC (Cash) - Wait 2s to avoid nonce clash
    await new Promise(r => setTimeout(r, 2000));
    console.log("👉 2/2: Approving USDC Spending...");
    const dataUSDC = encodeFunctionData({ abi: USDC_ABI, functionName: 'approve', args: [MARKET_ADDR, 115792089237316195423570985008687907853269984665640564039457584007913129639935n] });
    await sendSafeTx(wallet, PROXY_ADDR, USDC_ADDR, dataUSDC, nonce + 1n);

    console.log("✅ DONE! Market is now authorized.");
}

async function sendSafeTx(wallet, safe, to, data, nonce) {
    const domain = { chainId: 137, verifyingContract: safe };
    const types = { SafeTx: [{name:"to",type:"address"},{name:"value",type:"uint256"},{name:"data",type:"bytes"},{name:"operation",type:"uint8"},{name:"safeTxGas",type:"uint256"},{name:"baseGas",type:"uint256"},{name:"gasPrice",type:"uint256"},{name:"gasToken",type:"address"},{name:"refundReceiver",type:"address"},{name:"nonce",type:"uint256"}] };
    const message = { to, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce };
    
    // Sign and Execute
    const signature = await wallet.signTypedData({ domain, types, primaryType: 'SafeTx', message });
    const hash = await wallet.writeContract({ 
        address: safe, abi: SAFE_ABI, functionName: 'execTransaction', 
        args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", signature] 
    });
    console.log(`   Tx Hash: ${hash}`);
}

main().catch(console.error);