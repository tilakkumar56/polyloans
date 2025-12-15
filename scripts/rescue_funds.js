const { createPublicClient, http, parseAbi } = require('viem');
const { polygon } = require('viem/chains');

// CONFIG
const MARKET_ADDR = "0x30672b8B427BD7277c8467221441e2D3Dbf833E4"; 
const PROXY_ADDR  = "0x06CF8B375BD12E7256F8Da3e695857226b2b36d7"; 
const WALLET_ADDR = "0x87ECEbbE008c66eE0a45b4F2051Fe8e17f9afc1D";
const CTF_ADDR    = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

// The "Joe Biden" ID (0) and your Real ID (you can add others if needed)
const TOKEN_IDS = [
    0n, 
    21489772516410038586556744342392982044189999368638682594741395650226594484811n
];

const MARKET_ABI = parseAbi([
    "function nextRequestId() view returns (uint256)",
    "function requests(uint256) view returns (address, uint256, uint256, uint256, uint256, bool, bool)"
]);
const ERC1155_ABI = parseAbi(["function balanceOf(address, uint256) view returns (uint256)"]);

async function main() {
    const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });

    console.log("\n🕵️ DEEP SCAN REPORT");
    console.log("---------------------------------------------------");

    // 1. CHECK BALANCES
    console.log("1. WHERE ARE THE SHARES?");
    for (const id of TOKEN_IDS) {
        const walletBal = await client.readContract({ address: CTF_ADDR, abi: ERC1155_ABI, functionName: 'balanceOf', args: [WALLET_ADDR, id] });
        const proxyBal  = await client.readContract({ address: CTF_ADDR, abi: ERC1155_ABI, functionName: 'balanceOf', args: [PROXY_ADDR, id] });
        const marketBal = await client.readContract({ address: CTF_ADDR, abi: ERC1155_ABI, functionName: 'balanceOf', args: [MARKET_ADDR, id] });

        console.log(`   Token ID [${id.toString().slice(0,6)}...]`);
        console.log(`     - In Wallet: ${walletBal}`);
        console.log(`     - In Proxy:  ${proxyBal}  <-- If here, you are safe.`);
        console.log(`     - In Market: ${marketBal} <-- If here, they are locked.`);
    }

    // 2. CHECK REQUESTS
    console.log("\n2. CONTRACT REQUEST LOG");
    const nextId = await client.readContract({ address: MARKET_ADDR, abi: MARKET_ABI, functionName: 'nextRequestId' });
    
    if(nextId === 1n) {
        console.log("   Contract is EMPTY (No requests created yet).");
    } else {
        for (let i = 1; i < Number(nextId); i++) {
            const req = await client.readContract({ address: MARKET_ADDR, abi: MARKET_ABI, functionName: 'requests', args: [BigInt(i)] });
            // req: [borrower, tokenId, shares, principal, duration, isActive, isLoan]
            
            let status = "Unknown";
            if (req[5] && !req[6]) status = "🟢 PENDING (Waiting for Offer)";
            if (req[5] && req[6])  status = "🔵 ACTIVE LOAN";
            if (!req[5])           status = "🔴 CANCELLED / CLOSED";

            let owner = "Unknown";
            if (req[0].toLowerCase() === PROXY_ADDR.toLowerCase()) owner = "YOUR PROXY";
            if (req[0].toLowerCase() === WALLET_ADDR.toLowerCase()) owner = "YOUR WALLET";

            console.log(`   [Req #${i}] ${status}`);
            console.log(`       Owner: ${owner} (${req[0]})`);
            console.log(`       Asset: ${req[1]}`);
            console.log(`       Shares: ${req[2]}`);
        }
    }
    console.log("---------------------------------------------------");
}

main();