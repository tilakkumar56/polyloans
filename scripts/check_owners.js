const { createPublicClient, http, parseAbi } = require('viem');
const { polygon } = require('viem/chains');

const PROXY_ADDR = "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7";

const SAFE_ABI = parseAbi([
    "function getOwners() view returns (address[])",
    "function VERSION() view returns (string)"
]);

async function main() {
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });

    console.log(`🔎 Checking Proxy: ${PROXY_ADDR}`);
    
    try {
        const owners = await client.readContract({ address: PROXY_ADDR, abi: SAFE_ABI, functionName: 'getOwners' });
        const version = await client.readContract({ address: PROXY_ADDR, abi: SAFE_ABI, functionName: 'VERSION' });

        console.log(`📄 Safe Version: ${version}`);
        console.log(`🔑 Owners:`, owners);
        
        // Check against your env wallet
        const myWallet = "0x87ECEbbE008c66eE0a45b4F2051Fe8e17f9afc1D"; // From your error logs
        const isOwner = owners.some(o => o.toLowerCase() === myWallet.toLowerCase());

        if (isOwner) {
            console.log("✅ MATCH! Your wallet IS the owner.");
        } else {
            console.log("❌ MISMATCH! Your wallet is NOT the owner.");
            console.log("   -> You must switch your Private Key to one of the addresses above.");
        }

    } catch (e) {
        console.error("❌ Failed to read contract:", e.message);
    }
}

main();