const { createPublicClient, http, parseAbi } = require('viem');
const { polygon } = require('viem/chains');

const PROXY = "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7"; // Your Proxy
const WALLET = "0x87ECEbbE008c66eE0a45b4F2051Fe8e17f9afc1D"; // Your Wallet

const SAFE_ABI = parseAbi(["function getOwners() view returns (address[])", "function VERSION() view returns (string)"]);

async function main() {
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-rpc.com") });
    
    try {
        const owners = await client.readContract({ address: PROXY, abi: SAFE_ABI, functionName: 'getOwners' });
        const version = await client.readContract({ address: PROXY, abi: SAFE_ABI, functionName: 'VERSION' });
        
        console.log(`\n🔎 Proxy: ${PROXY}`);
        console.log(`📄 Safe Version: ${version}`);
        console.log(`🔑 Owners:`, owners);
        
        const isOwner = owners.some(o => o.toLowerCase() === WALLET.toLowerCase());
        
        if (isOwner) {
            console.log(`✅ SUCCESS: ${WALLET} IS an owner.`);
        } else {
            console.log(`❌ FAILURE: ${WALLET} is NOT an owner.`);
            console.log(`   You must connect with one of the owner addresses listed above.`);
        }
    } catch(e) {
        console.error("Error:", e.message);
    }
}

main();