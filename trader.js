"use strict";

const WatcherNew = require("./watcher");
const reporter = require("./reporter");
const StrategySpawner = require("./strategies");

const krakenConfig = require("./config/kraken.json");
const traderConfig = require("./config/trader.json");

const key = krakenConfig.key;
const secret = krakenConfig.secret;

function getPairForName(name) {
  const list = krakenConfig.pairs.filter(pair => {
    return pair && pair.pair && pair.pair === name;
  });
  if(list.length > 0) return list[0];
  return undefined;
}

const watchers = [];

traderConfig.strategies.forEach(strategy => {
  const money = getPairForName(strategy.pair);
  if(money) {
    const watcher = new WatcherNew(key, secret, money.pair);
    const strateger = new StrategySpawner(key, secret);

    strateger.createTrader(money, strategy.algorithm, strategy.options);

    watcher.on("data", (data) => {
      strateger.sendDataToWorker(money, strategy.algorithm, {
        current: data.current,
        volatility: data.volatility["24h"]
      });
    });

    watchers.push(watcher);
  } else {
    console.error("unknown pair");
  }
});


watchers.forEach(watcher => {
  console.log("starting watcher");
  const consoleReporter = new reporter.console(watcher);

  watcher.start();
});
