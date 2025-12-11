const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("🚀 Deploying Market with Native USDC...");

  // ✅ NATIVE USDC (Polygon)
  const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; 
  const CTF_ADDRESS  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; 

  const PolyLendMarket = await hre.ethers.getContractFactory("PolyLendMarket");
  const market = await PolyLendMarket.deploy(USDC_ADDRESS, CTF_ADDRESS);
  await market.waitForDeployment();

  console.log("✅ DEPLOYED!");
  console.log("📍 NEW MARKET ADDRESS:", market.target);
  console.log("⚠️ COPY THIS ADDRESS NOW!");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });