"use strict";

const _ = require('lodash');

const KrakenWrapper = require("./kraken");
const WatcherNew = require("./watcher");
const reporter = require("./reporter");
const StrategySpawner = require("./strategies");

const krakenConfig = require("./config/kraken.json");
const traderConfig = require("./config/trader.json");

const key = krakenConfig.key;
const secret = krakenConfig.secret;

const watchers = [];

function initWatch(watcher_name) {
  const watcher = new WatcherNew(key, secret, watcher_name);
  const holder = {
    name: watcher_name,
    watcher: watcher
  };

  watchers.push(holder);
  return holder;
}

_.forIn(traderConfig.watchers, (watch) => {
  initWatch(watch);
});

_.forIn(traderConfig.strategies, (strategy) => {
  const money = _.find(krakenConfig.pairs, {pair: strategy.pair});
  if(money) {

    //override api for a given bot ?
    var _key = key;
    var _secret = secret;
    if(strategy.api && strategy.api.key && strategy.api.secret) {
      _key = strategy.api.key;
      _secret = strategy.api.secret;
    }
    const strateger = new StrategySpawner(_key, _secret);
    var holder = _.find(watchers, { name: strategy.pair});

    if(!holder) {
      holder = initWatch(money.pair);
    }

    strateger.createTrader(money, strategy.algorithm, strategy.options);

    holder.watcher.on("data", (data) => {
      strateger.sendDataToWorker(money, strategy.algorithm, {
        current: data.current,
        volatility: data.volatility["24h"]
      });
    });

  } else {
    console.error("unknown pair");
  }
});


watchers.forEach(item => {
  console.log("starting watcher");
  const consoleReporter = new reporter.console(item.watcher);

  item.watcher.start();
});
