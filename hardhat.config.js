// hardhat.config.js
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  // 🔥 UPDATED COMPILER VERSION 🔥
  solidity: "0.8.20", 
  networks: {
    polygon: {
      url: process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com",
      accounts: [process.env.PRIVATE_KEY],
      // Aggressive gas settings to ensure it goes through
      gasPrice: 250000000000, // 250 Gwei
    },
  },
  etherscan: {
    apiKey: process.env.POLYGONSCAN_API_KEY // Optional: If you verify later
  }
};