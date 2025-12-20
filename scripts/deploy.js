// scripts/deploy.js
const hre = require("hardhat");

async function main() {
  // 1. Get the Contract Factory
  const PolyLoans = await hre.ethers.getContractFactory("PolyLoans");

  // 2. Define the Addresses (Polygon Mainnet)
  // USDC: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
  // Polymarket (CTF): 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045
  const usdcAddr = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
  const polyAddr = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

  console.log("Deploying PolyLoans...");

  // 3. Deploy
  const market = await PolyLoans.deploy(usdcAddr, polyAddr);
  await market.waitForDeployment();

  // 4. Print the Address
  console.log("----------------------------------------------------");
  console.log("✅ Contract Deployed to:", await market.getAddress());
  console.log("----------------------------------------------------");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});