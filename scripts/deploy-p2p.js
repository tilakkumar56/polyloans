const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("🚀 Deploying NEGOTIATION Market...");

  const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; 
  const CTF  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; 

  const PolyLendMarket = await hre.ethers.getContractFactory("PolyLendMarket");
  const market = await PolyLendMarket.deploy(USDC, CTF);
  await market.waitForDeployment();

  console.log("✅ Market Address:", market.target);
}

main().catch(console.error);