"use strict";

const _ = require('lodash'),
moment = require("moment"),
helper = require('../helper'),
KrakenWrapper = require('../kraken');

//TODO when restoring buy order from existing one :
//calculate the "normal" price from it
//to calculate the proper sell price !
const sendMessage = helper.ipc.sendMessage;
const round = helper.round;
const ceil = helper.ceil;
const floor = helper.floor;

const MAX_DECIMAL_ACCURACY = 5;

const MODE_ERASE_CURRENT_BUY = "MODE_ERASE_CURRENT_BUY";
const MODE_SELL_FROM_CURRENT_BUY = "MODE_SELL_FROM_CURRENT_BUY";

let LOG_PREFIX = '<bit-trader:trader/micro-trades>';

let api = null;
let pair = {
  crypto: "",
  fiat: "",
  pair: "",
  pair_short: ""
};

//store the possible errors when trying to sell crypto but nothing in store
let inErrorSellAmountCount = 0;

let options = {};
let openOrder = {id: null, sellPrice: 0, sellAmount: 0};
let isInTrade = false;
let cumulativeProfit = 0;

let hasCheckBeforeStart = false;
let isInCheckBeforeStart = false;

let currentModeOnStartup = MODE_SELL_FROM_CURRENT_BUY;

let stopped = false;

let isWaiting = false;
let waitingUntil = undefined;

function resetOpenOrder() {
  openOrder = {id: null, sellPrice: 0, sellAmount: 0};
  isInTrade = false;
}

function callbackWhenBuyIsOk() {
  api.getTradableVolume().then((pairs) => {
    return _.get(pairs, pair.crypto);
  })
  .then((maxTradeableCrypto) => {

    var sellAmount = openOrder.sellAmount;

    if(sellAmount > maxTradeableCrypto) {
      var previousSellAmount = sellAmount;
      sellAmount = maxTradeableCrypto;
      sendMessage('sell', `${LOG_PREFIX} can not sell ${previousSellAmount}, fixed to ${sellAmount}`);

      if(sellAmount === 0) {
        inErrorSellAmountCount ++;

        if(inErrorSellAmountCount > 4) {
          sendMessage('sell', `${LOG_PREFIX} can not sell for more than 4 times, try reset`);
          resetOpenOrder();
          inErrorSellAmountCount = 0;
        }
      }
    }

    api.execTrade(pair.pair, 'sell', 'limit', openOrder.sellPrice, sellAmount).then((oId) => {
      openOrder = {id: oId};
      sendMessage('sell', `${LOG_PREFIX} buy order fulfilled`);
    })
    .catch(e => {
      console.error(e);
      //we have an issue... check for cause
      hasCheckBeforeStart = false;
    });

  })
  .catch(e => {
  });
}

function manageCurrentWaitingTransaction() {
  api.getOrderInfo(openOrder.id).then((orderInfo) => {
    if (orderInfo.status === 'closed') {
      if (orderInfo.type === 'sell') {
        resetOpenOrder();

        sendMessage('fin', `${LOG_PREFIX} sell fulfilled`);

        if(!isNaN(options.waitFor) && Number(options.waitFor) > 0) {
          const waitFor = Number(options.waitFor);
          waitingUntil = moment().add(waitFor, "minutes");
          isWaiting = true;

          sendMessage('fin', `${LOG_PREFIX} waiting for ${waitFor} minutes`);
        }
      } else if (orderInfo.type === 'buy') {

        callbackWhenBuyIsOk();

      }
    } else if (orderInfo.status === 'open') {
      sendMessage('waiting', `${LOG_PREFIX} waiting for orders to fulfill`);
    } else if (orderInfo.status === "partial") {
      sendMessage("waiting", `${LOG_PREFIX} transaction is now partial`);
    } else if (orderInfo.status === "canceled") {
      api.getOrderInfo(openOrder.id)
      .then(orderInfo => {

        //we must now check the different info
        //TODO manage the user canceled VS out of funds : partial?
        if(orderInfo) {

          if(orderInfo.reason && orderInfo.reason === "Out of funds") {
            //force managed possible funds !
            sendMessage("fin", `${LOG_PREFIX} order canceled but out of funds, must be because was bought but issue with kraken`);
            callbackWhenBuyIsOk();
          } else {
            const order = orderInfo;
            resetOpenOrder();

            if(orderInfo.reason && orderInfo.reason === "User canceled") {
              sendMessage('fin', `${LOG_PREFIX} canceled by user - manual management`);
            } else {
              sendMessage('fin', `${LOG_PREFIX} canceled - manual management to do := `+orderInfo.reason);
            }
          }

        } else {
          console.log(infos);
        }
      })
    }
  });
}

function createBuyTransaction(current, volatility) {

  inErrorSellAmountCount = 0;

  let buyPrice = floor(current - current * (1. * options.microPercent / 100), MAX_DECIMAL_ACCURACY);
  let buyAmount = floor(options.maxMoneyToUse / buyPrice, MAX_DECIMAL_ACCURACY);
  let buyValue = buyPrice * buyAmount;

  //sell at current price * (100%+microPercent)
  let sellPrice = floor(current + current * (1. * options.multiplicator * options.microPercent / 100), MAX_DECIMAL_ACCURACY);
  //sellPrice = round(buyPrice + buyPrice * (1. * options.multiplicator * options.microPercent / 100), MAX_DECIMAL_ACCURACY);;//(options.multiplicator * options.minSellDiff);

  api.getTradableVolume().then((pairs) => {
    return _.get(pairs, pair.fiat);
  }).then((maxTradeableMoney) => {

    if (buyValue > maxTradeableMoney) {
      buyAmount = floor(maxTradeableMoney / buyPrice, MAX_DECIMAL_ACCURACY);
    }

    let maxMinPrice = round(current - (buyPrice * volatility), MAX_DECIMAL_ACCURACY);
    let maxMaxPrice = round(current + (buyPrice * volatility), MAX_DECIMAL_ACCURACY);

    buyPrice = floor(buyPrice, MAX_DECIMAL_ACCURACY);
    sellPrice = round(sellPrice, MAX_DECIMAL_ACCURACY);

    if(maxTradeableMoney == 0 || (buyPrice*buyAmount) == 0) {
      sendMessage('noTrade', `${LOG_PREFIX} not enough volume to buy (buy: ${buyPrice}, sell: ${sellPrice})`);

      if(maxTradeableMoney) hasCheckBeforeStart = false;
    }else if (buyPrice >= maxMinPrice && sellPrice <= maxMaxPrice) {
      isInTrade = true;

      api.execTrade(pair.pair, 'buy', 'limit', buyPrice, buyAmount).then((oId) => {
        openOrder = {
          id: oId,
          sellPrice: sellPrice,
          sellAmount: buyAmount,
        };

        let profit = round((sellPrice - buyPrice) * buyAmount, MAX_DECIMAL_ACCURACY);
        cumulativeProfit = cumulativeProfit + profit;

        sendMessage('buy', `${LOG_PREFIX} creating buy order (b:${buyPrice}, s:${sellPrice}, p: ${profit}, cP: ${cumulativeProfit})`, openOrder);
      })
      .catch(e => {
        console.error(e);
        //we must check whether we have the buy order ok...
        hasCheckBeforeStart = false;
      });
    } else {
      sendMessage('noTrade', `${LOG_PREFIX} not enough volatility for trade (buy: ${buyPrice}, sell: ${sellPrice})`);
    }
  });
}

function manageStartupTrade() {
  if(!isInCheckBeforeStart) {
    isInCheckBeforeStart = true;

    api.getOpenOrders().then(orders => {
      if(currentModeOnStartup === MODE_ERASE_CURRENT_BUY) {
        _.forIn(orders, (order) => {
          if(order && order.pair === pair.pair_short && order.type === "buy") {
            api.cancelOrder(order.id).then(() => {
              sendMessage('buy', `${LOG_PREFIX} tx ${order.id} is at least canceling`);
            }).catch(e => {
              console.error(e);
            });
          }
        });
      } else if(currentModeOnStartup === MODE_SELL_FROM_CURRENT_BUY) {
        var buy_found = false;
        _.forIn(orders, (order) => {
          if(order && order.pair === pair.pair_short && order.type === "buy") {
            buy_found = true;
            const buyPrice = order.price;
            const buyAmount = order.amount;

            const sellPrice = round((1.0 + options.multiplicator * options.microPercent / 100) * buyPrice / (1.0 - options.multiplicator * options.microPercent / 100), MAX_DECIMAL_ACCURACY);

            //const beforeSellPrice = round(buyPrice + buyPrice * (1. * options.multiplicator * options.microPercent / 100), MAX_DECIMAL_ACCURACY);;//(options.multiplicator * options.minSellDiff);
            //console.log(sellPrice+" versus "+ beforeSellPrice);
            console.log(buyPrice+" "+sellPrice);

            openOrder = {
              id: order.id,
              sellPrice: sellPrice,
              sellAmount: buyAmount
            };
            isInTrade = true;
            sendMessage('buy', `${LOG_PREFIX} tx for BUY was set before. We use it as a base`);
          }
        });


        if(!buy_found) {
          //if we did not find a buy order, we also check if we have a sell in progress
          //it can happens when crash in the app or buy passed but info did not come
          _.forIn(orders, (order) => {
            if(order && order.pair === pair.pair_short && order.type === "sell") {
              openOrder = { id: order.id };
              isInTrade = true;
              sendMessage('buy', `${LOG_PREFIX} tx for SELL was set before. We use it as a base`);
            }
          });
        }
      }

      hasCheckBeforeStart = true;
      isInCheckBeforeStart = false;

      //since we applied the error management
      //we will use this callback whenever we have an issue with buy calls !
      currentModeOnStartup = MODE_SELL_FROM_CURRENT_BUY;
    }).catch((e) => {
      console.error(e);
      hasCheckBeforeStart = true;
      isInCheckBeforeStart = false;
    });
  }
}

function inWaitingBlock() {
  if(moment().isAfter(waitingUntil)) {
    isWaiting = false;
    sendMessage('buy', `${LOG_PREFIX} wait time finished, restarting`);
  } else {
    sendMessage('buy', `${LOG_PREFIX} waiting`);
  }
}


function trade(current, volatility) {
  if(!waitingUntil) isWaiting = false;

  if(isWaiting) {
    inWaitingBlock();
  } else if(stopped) {
    //STOP RIGHT HERE
    //TODO implement?
  } else if(!hasCheckBeforeStart) {
    manageStartupTrade();
  } else if (isInTrade && openOrder && openOrder.id) {
    manageCurrentWaitingTransaction();
  } else {
    createBuyTransaction(current, volatility);
  }
}

process.on('message', (message) => {
  const data = message.data;

  switch (message.type) {
    case 'startup':
    api = new KrakenWrapper(data.key, data.secret);
    pair = data.pair;
    options = data.options;
    LOG_PREFIX = `${LOG_PREFIX} ${pair.pair}`;
    sendMessage('ready', `${LOG_PREFIX} ready`);
    break;

    case 'analyze':
    trade(data.current, data.volatility);
    break;
  }
});
