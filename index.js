const bodyParser = require("body-parser");
const Core = require("bitcoin-core");
const express = require("express");
const fs = require("fs");
const http = require("http");
const level = require("level");
const pino = require("express-pino-logger")();
const WebSocket = require("ws");
const config = require("./config");

const db = level("db");
const l = console.log;

const assets = {
  "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d": "bitcoin",
  ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2: "tether"
};

const wss = new WebSocket.Server({ port: 8182 });

wss.on("connection", function connection(ws) {
  app.set("ws", ws);
});

const bc = new Core(config.elementsd);

const binance = new WebSocket(
  "wss://stream.binance.com:9443/ws/btcusdt@ticker"
);

binance.onmessage = async function(event) {
  let msg = JSON.parse(event.data);
  app.set("bid", msg.b);
  app.set("ask", msg.a);
  app.set("last", msg.l);
  app.set("balance", await bc.getBalance());
  checkQueue();
};

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(pino);

app.get("/balance", async (req, res) => {
  res.send(app.get("balance"));
});

const createProposal = (a1, v1, a2, v2) =>
  new Promise((resolve, reject) => {
    const spawn = require("child_process").spawn;
    const proc = spawn("liquidswap-cli", [
      "-c",
      config.conf,
      "propose",
      a1,
      v1,
      a2,
      v2
    ]);

    proc.stdout.on("data", data => {
      fs.writeFile("proposal.txt", data.toString(), function(err) {
        if (err) {
          return l(err);
        }
        l("The file was saved!");
      });
      resolve(data.toString());
    });

    proc.stderr.on("error", err => {
      reject(err.toString());
    });
  });

const getInfo = () =>
  new Promise((resolve, reject) => {
    const spawn = require("child_process").spawn;
    const proc = spawn("liquidswap-cli", [
      "-c",
      config.conf,
      "info",
      "proposal.txt"
    ]);

    proc.stdout.on("data", data => {
      resolve(data.toString());
    });

    proc.stderr.on("data", err => {
      reject(err.toString());
    });

    setTimeout(() => reject("timeout"), 2000);
  });

app.get("/proposal", async (req, res) => {
  try {
    const { a1, v1, a2, v2 } = req.query;
    const b = app.get("balance");

    if (!(assets[a1] && assets[a2])) throw new Error("unsupported assets");
    if (v1 > b[assets[a1]]) throw new Error("not enough funds");

    req.log.info(
      `proposal requested to swap ${v1} ${assets[a1]} for ${v2} ${assets[a2]}`
    );

    const proposal = await createProposal(a1, v1, a2, v2);
    const info = JSON.parse(await getInfo());
    const [fee, rate, asset] = parse(info);

    if (!rate) throw new Error("invalid asset pair");
    if (rate < 0)
      throw new Error(`${assets[a1]} amount must be greater than ${fee}`);

    res.send({ proposal, info, rate, asset });
  } catch (e) {
    l(e);
    res.status(500).send({ error: e.message });
  }
});

app.post("/acceptance", async (req, res) => {
  const { acceptance: text } = req.body;
  req.log.info("acceptance received");

  fs.writeFile("accepted.txt", text, async err => {
    if (err) {
      return res.status(500).send(err);
    }

    try {
      let info = JSON.parse(
        await new Promise((resolve, reject) => {
          const spawn = require("child_process").spawn;
          const proc = spawn("liquidswap-cli", [
            "-c",
            config.conf,
            "info",
            "accepted.txt"
          ]);

          proc.stdout.on("data", data => {
            resolve(data.toString());
          });

          proc.stderr.on("data", err => {
            reject(err.toString());
          });

          setTimeout(() => reject("timeout", proc), 2000);
        })
      );

      const time = Math.floor(new Date()).toString();
      const [fee, rate, asset] = parse(info);
      if (!asset) throw new Error("unsupported asset");
      req.log.info("accepted", info, rate, asset);

      db.put(time, JSON.stringify({ text, info, rate, asset }));
      l({ text, info, rate, asset });

      res.send({ info, rate });
    } catch (e) {
      req.log.error(e);
      res.status(500).send({ error: e });
    }
  });
});

const checkQueue = async () => {
  const ws = app.get("ws");
  const txs = [];

  db.createReadStream()
    .on("data", async function(data) {
      txs.push({ ...JSON.parse(data.value), key: data.key });
    })
    .on("end", async function(data) {
      const rate = (a, b) => a.rate - b.rate;
      const time = (a, b) => b.time - a.time;

      const pending = txs.filter(tx => !tx.id);
      const completed = txs.filter(tx => tx.id).sort(time);

      const bitcoin = pending
        .filter(tx => tx.asset === "bitcoin")
        .sort(rate)
        .reverse();
      const tether = pending
        .filter(tx => tx.asset === "tether")
        .sort(rate)
        .reverse();

      const strip = a =>
        a.map(({ id, key, info, rate, time }) => ({
          id,
          key,
          info,
          rate,
          time
        }));

      ws &&
        ws.send(
          JSON.stringify({
            completed: strip(completed.slice(0, 3)),
            bitcoin: strip(bitcoin.slice(0, 3)),
            tether: strip(tether.slice(0, 3))
          })
        );

      let b, t, tx;
      if (bitcoin[0]) b = bitcoin[0].rate - app.get("ask");
      if (tether[0]) t = tether[0].rate - 1 / app.get("bid");

      if (b > 0 || t > 0) {
        if ((b && !t) || b > t) tx = bitcoin[0];
        if ((t && !b) || t > b) tx = tether[0];
      }

      if (tx) {
        try {
          tx.id = JSON.parse(await finalize(tx.text)).txid;
          tx.time = Date.now();
          delete tx.text;
          db.put(tx.key, JSON.stringify(tx));
        } catch (e) {
          l(e);
          if (e.includes("Unexpected fees")) db.del(tx.key);
          if (e.includes("unsigned inputs")) db.del(tx.key);
          if (e.includes("insufficient fee")) db.del(tx.key);
        }
      }
    });
};

const parse = info => {
  let fee, rate, asset;

  if (
    assets[info.legs[0].asset] === "bitcoin" &&
    assets[info.legs[1].asset] === "tether"
  ) {
    asset = "bitcoin";
    fee = info.legs[0].fee;

    rate = (info.legs[1].amount / (info.legs[0].amount + fee)).toFixed(8);
  }

  if (
    assets[info.legs[1].asset] === "bitcoin" &&
    assets[info.legs[0].asset] === "tether"
  ) {
    asset = "tether";
    fee = info.legs[1].fee;

    rate = ((info.legs[1].amount - fee) / info.legs[0].amount).toFixed(8);
  }

  return [fee, rate, asset];
};

const finalize = text => {
  fs.writeFileSync("accepted.txt", text);

  return new Promise((resolve, reject) => {
    const spawn = require("child_process").spawn;
    const proc = spawn("liquidswap-cli", [
      "-c",
      config.conf,
      "finalize",
      "accepted.txt",
      "--send"
    ]);

    proc.stdout.on("data", data => {
      resolve(data.toString());
    });

    proc.stderr.on("data", err => {
      reject(err.toString());
    });

    setTimeout(() => reject("timeout"), 2000);
  });
};

app.listen(3001, () => l("Express server is running on localhost:3001"));
