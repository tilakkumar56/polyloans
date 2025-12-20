const { createPublicClient, http, parseAbi } = require('viem');
const { polygon } = require('viem/chains');

// CONFIG
const MARKET_ADDR = "0xe5D387e0135dab4D722838DA348e6f51E9C871Af"; 

const MARKET_ABI = parseAbi([
    "function nextRequestId() view returns (uint256)",
    "function requests(uint256) view returns (address, uint256, uint256, uint256, uint256, bool, bool)"
]);

async function main() {
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });

    console.log("\n🕵️ DEEP SCANNING CONTRACT REQUESTS...");
    console.log(`   Contract: ${MARKET_ADDR}`);
    
    try {
        const nextId = await client.readContract({ address: MARKET_ADDR, abi: MARKET_ABI, functionName: 'nextRequestId' });
        console.log(`   Total Requests: ${Number(nextId) - 1}\n`);

        for (let i = 1; i < Number(nextId); i++) {
            const req = await client.readContract({ address: MARKET_ADDR, abi: MARKET_ABI, functionName: 'requests', args: [BigInt(i)] });
            
            // req: [borrower, tokenId, shares, principal, duration, isActive, isLoan]
            const tokenId = req[1].toString();
            
            console.log(`   [Request #${i}]`);
            console.log(`     Token ID: ${tokenId}`);  // <--- THIS IS THE ID YOU NEED
            console.log(`     Active:   ${req[5]}`);
            console.log(`     Is Loan:  ${req[6]}`);
            console.log("---------------------------------------------------");
        }
    } catch(e) {
        console.error("Scan Error:", e.message);
    }
}

main();