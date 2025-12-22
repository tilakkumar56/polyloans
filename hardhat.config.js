require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20", // Matches the version in your Solidity files
    settings: {
      optimizer: {
        enabled: true, // This helps save gas
        runs: 200,
      },
    },
  },
  networks: {
    // This is the part that was missing
    polygon: {
      url: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};