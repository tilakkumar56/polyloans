require("@nomicfoundation/hardhat-toolbox");
require('dotenv').config();

module.exports = {
  solidity: "0.8.20",
  networks: {
    polygon: {
      // ✅ NEW: This is a stable, open public node
      url: "https://polygon-bor-rpc.publicnode.com", 
      accounts: [process.env.PRIVATE_KEY]
    }
  }
};