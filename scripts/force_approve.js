const { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
require('dotenv').config();

// ⚠️ CONFIRM THIS IS YOUR LATEST MARKET ADDRESS
const MARKET_ADDR = "0x08190EAE6A7497804C9315D8e46CB217e9a6244f"; 

const PROXY_ADDR  = "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7"; 
const CTF_ADDR    = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; 
const USDC_ADDR   = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; 
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)", "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)"]);
const CTF_ABI = parseAbi(["function setApprovalForAll(address, bool) external"]);
const USDC_ABI = parseAbi(["function approve(address, uint256) external"]);

async function main() {
    if(!PRIVATE_KEY) throw new Error("Check .env file for PRIVATE_KEY");

    const account = privateKeyToAccount(PRIVATE_KEY);
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
    const wallet = createWalletClient({ account, chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });

    console.log(`🔐 Authorizing Market: ${MARKET_ADDR}`);
    
    // 1. Get Nonce
    let nonce = await client.readContract({ address: PROXY_ADDR, abi: SAFE_ABI, functionName: 'nonce' });
    console.log(`🔹 Initial Nonce: ${nonce}`);

    // 2. Approve Shares
    console.log("👉 1/2: Approving Shares...");
    await sendSafeTx(client, wallet, PROXY_ADDR, CTF_ADDR, encodeFunctionData({ 
        abi: CTF_ABI, functionName: 'setApprovalForAll', args: [MARKET_ADDR, true] 
    }), nonce);

    // 3. Approve USDC (Refetch nonce to be safe)
    nonce = await client.readContract({ address: PROXY_ADDR, abi: SAFE_ABI, functionName: 'nonce' });
    console.log(`🔹 Updated Nonce: ${nonce}`);
    
    console.log("👉 2/2: Approving USDC...");
    await sendSafeTx(client, wallet, PROXY_ADDR, USDC_ADDR, encodeFunctionData({ 
        abi: USDC_ABI, functionName: 'approve', args: [MARKET_ADDR, 115792089237316195423570985008687907853269984665640564039457584007913129639935n] 
    }), nonce);

    console.log("✅ DONE! The 500 Error will be gone.");
}

async function sendSafeTx(client, wallet, safe, to, data, nonce) {
    const domain = { chainId: 137, verifyingContract: safe };
    const types = { SafeTx: [{name:"to",type:"address"},{name:"value",type:"uint256"},{name:"data",type:"bytes"},{name:"operation",type:"uint8"},{name:"safeTxGas",type:"uint256"},{name:"baseGas",type:"uint256"},{name:"gasPrice",type:"uint256"},{name:"gasToken",type:"address"},{name:"refundReceiver",type:"address"},{name:"nonce",type:"uint256"}] };
    
    // safeTxGas is 0 to match
    const message = { to, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce };
    
    const signature = await wallet.signTypedData({ domain, types, primaryType: 'SafeTx', message });
    
    const hash = await wallet.writeContract({ 
        address: safe, abi: SAFE_ABI, functionName: 'execTransaction', 
        args: [
            message.to, 
            message.value, 
            message.data, 
            message.operation, 
            0n, 
            message.baseGas, 
            message.gasPrice, 
            message.gasToken, 
            message.refundReceiver, 
            signature
        ],
        gas: 500000n // External Gas
    });
    console.log(`   Tx Sent: ${hash}`);
    console.log(`   ⏳ Waiting for confirmation...`);
    await client.waitForTransactionReceipt({ hash });
    console.log(`   ✅ Confirmed.`);
}

main().catch(console.error);