const home = require("os").homedir();
const auth = fs.readFileSync(`${home}/.elements/liquidv1/.cookie`, "utf8");

export default {
  bitcoind: {
    wallet: "wallet",
    walletpass: "password",
    network: "mainnet",
    username: "__cookie__",
    port: 7041
  }
};
