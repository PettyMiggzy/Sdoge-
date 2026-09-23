require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Arc's baseline is the Osaka hardfork (newer than Cancun) - Arc's own
      // docs say pinning to "paris" was an early workaround that's no longer
      // necessary. Cancun is required regardless: OpenZeppelin 5.x's
      // ERC1155 pulls in Arrays.sol, which uses the MCOPY opcode
      // (introduced in Cancun) - this wouldn't even compile at "paris".
      evmVersion: "cancun",
    },
  },
  networks: {
    arc: {
      url: process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io",
      chainId: 5042,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};
