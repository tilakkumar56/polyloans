// scripts/deploy.js
const hre = require("hardhat");

async function main() {
  console.log("🚀 Starting ECONOMY Deployment...");

  const [deployer] = await hre.ethers.getSigners();
  const PolyLoans = await hre.ethers.getContractFactory("PolyLoans");
  const usdcAddr = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
  const polyAddr = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

  // 1. Get Nonce
  const latestNonce = await hre.ethers.provider.getTransactionCount(deployer.address, "latest");
  console.log(`🔄 Nonce: ${latestNonce}`);

  // 2. ECONOMY SETTINGS (Fits your remaining balance)
  // Price: 450 gwei (Market average is ~400-450 right now)
  const HARD_GAS_PRICE = hre.ethers.parseUnits("450", "gwei");
  // Limit: 2.2M (Still safe, but cheaper than 2.5M)
  const HARD_GAS_LIMIT = 2200000;

  console.log(`⛽ Gas Price: 450 gwei`);
  console.log(`📉 Gas Limit: 2.2 million`);
  console.log("📝 Deploying...");

  // 3. DEPLOY
  const market = await PolyLoans.deploy(usdcAddr, polyAddr, {
    maxFeePerGas: HARD_GAS_PRICE,
    maxPriorityFeePerGas: HARD_GAS_PRICE,
    gasLimit: HARD_GAS_LIMIT,
    nonce: latestNonce,
  });

  console.log("⏳ Transaction sent! Waiting for confirmation...");
  
  await market.waitForDeployment();

  console.log("----------------------------------------------------");
  console.log("✅ Contract Deployed to:", await market.getAddress());
  console.log("----------------------------------------------------");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});