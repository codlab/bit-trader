"use strict";

//load environment vars
require("dotenv").config()

const _ = require("lodash");
const KrakenWrapper = require("./kraken");
const WatcherNew = require("./watcher");
const reporter = require("./reporter");
const StrategySpawner = require("./strategies/index.js");
const MicroTrade = require("./strategies/micro-trades.js");


const krakenConfig = require("./config/kraken.json");
const traderConfig = require("./config/trader.json");

//use kraken keys from .env file
//see .env.example for initialization
const key = process.env.DEFAULT_KRAKEN_KEY;
const secret = process.env.DEFAULT_KRAKEN_SECRET;
const decimals = krakenConfig.decimals;

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
      _key = process.env[strategy.api.key];
      _secret = process.env[strategy.api.secret];

      if(!_key || !_secret) {
        throw("No key or secret matching in .env was found !");
      }
    }
    //const strateger = new StrategySpawner(_key, _secret);
    console.log("create strateger for "+strategy.pair);
    const strateger = new MicroTrade(_key, _secret, decimals);
    var holder = _.find(watchers, { name: strategy.pair});

    if(!holder) {
      holder = initWatch(money.pair);
    }

    //the strager will then manage in case of multiple "options"
    //the given options one after each other
    strateger.init(money, strategy.algorithm, strategy.options);

    holder.watcher.on("data", (data) => {
      strateger.sendDataToWorker(money, strategy.algorithm, {
        current: data.current,
        volatility: data.volatility["24h"]
      });
    });

  } else {
    console.error("unknown pair", strategy.pair);
  }
});


watchers.forEach(item => {
  console.log("starting watcher");
  const consoleReporter = new reporter.console(item.watcher);

  item.watcher.start();
});
