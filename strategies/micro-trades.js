"use strict";

const _ = require('lodash');

const helper = require('../helper');
const sendMessage = helper.ipc.sendMessage;
const round = helper.round;
const ceil = helper.ceil;
const floor = helper.floor;

const KrakenWrapper = require('../kraken');

const MAX_DECIMAL_ACCURACY = 5;
let LOG_PREFIX = '<bit-trader:trader/micro-trades>';

//TODO cleanup logging
//TODO add statistics over trade-yes-no calculation-time

let api = null;
let pair = {
  crypto: "",
  fiat: "",
  pair: "",
  pair_short: ""
};
let options = {};
let openOrder = {id: null, sellPrice: 0, sellAmount: 0};
let isInTrade = false;
let cumulativeProfit = 0;

let hasCheckBeforeStart = false;
let isInCheckBeforeStart = false;

const MODE_ERASE_CURRENT_BUY = "MODE_ERASE_CURRENT_BUY";
const MODE_SELL_FROM_CURRENT_BUY = "MODE_SELL_FROM_CURRENT_BUY";

let currentModeOnStartup = MODE_SELL_FROM_CURRENT_BUY;

let stopped = false;



function trade(current, volatility) {
  if(stopped) {
    //STOP RIGHT HERE
  } else if(!hasCheckBeforeStart) {
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
              const sellPrice = round(buyPrice + buyPrice * (1. * options.multiplicator * options.microPercent / 100), MAX_DECIMAL_ACCURACY);;//(options.multiplicator * options.minSellDiff);

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
  } else if (isInTrade && openOrder && openOrder.id) {
    api.getOrderInfo(openOrder.id).then((orderInfo) => {
      if (orderInfo.status === 'closed') {
        if (orderInfo.type === 'sell') {
          openOrder = {id: null, sellPrice: 0, sellAmount: 0};
          isInTrade = false;

          sendMessage('fin', `${LOG_PREFIX} sell fulfilled`);
        } else if (orderInfo.type === 'buy') {

          api.getTradableVolume().then((pairs) => {
            return _.get(pairs, pair.crypto);
          })
          .then((maxTradeableCrypto) => {

            var sellAmount = openOrder.sellAmount;

            if(sellAmount > maxTradeableCrypto) {
              var previousSellAmount = sellAmount;
              sellAmount = maxTradeableCrypto;
              sendMessage('sell', `${LOG_PREFIX} can not sell ${previousSellAmount}, fixed to ${sellAmount}`);
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
            const order = orderInfo;
            openOrder = {id: null, sellPrice: 0, sellAmount: 0};
            isInTrade = false;

            if(orderInfo.reason && orderInfo.reason === "User canceled") {
              sendMessage('fin', `${LOG_PREFIX} canceled by user - manual management`);
            } else {
              sendMessage('fin', `${LOG_PREFIX} canceled - manual management to do := `+orderInfo.reason);
            }


          } else {
            console.log(infos);
          }
        })
      }
    });
  } else {
    let buyPrice = 0;
    let buyAmount = 0;
    let buyValue = 0;
    let sellPrice = 0;

    if(options.microPercent) {
      buyPrice = floor(current - current * (1. * options.microPercent / 100), MAX_DECIMAL_ACCURACY);
      buyAmount = floor(options.maxMoneyToUse / buyPrice, MAX_DECIMAL_ACCURACY);
      buyValue = buyPrice * buyAmount;

      //sell at current price * (100%+microPercent)
      sellPrice = floor(current + current * (1. * options.multiplicator * options.microPercent / 100), MAX_DECIMAL_ACCURACY);
      //sellPrice = round(buyPrice + buyPrice * (1. * options.multiplicator * options.microPercent / 100), MAX_DECIMAL_ACCURACY);;//(options.multiplicator * options.minSellDiff);
    } else {
      buyPrice = current - options.minDiff;
      buyAmount = round(options.maxMoneyToUse / buyPrice, MAX_DECIMAL_ACCURACY);
      buyValue = buyPrice * buyAmount;
      sellPrice = buyPrice + (options.multiplicator * options.minSellDiff);
    }

    api.getTradableVolume().then((pairs) => {
      return _.get(pairs, pair.fiat);//_.get(pairs, pair.substr(-3));
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

        if(maxTradeableMoney) {
          //we must check if it is because we are already trying to sell
          //TODO manage when in fact for a pair XY we have X=0 and Y=0
          hasCheckBeforeStart = false;
        }
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
          //happens sometimes
          //TODO check error type :
          //insufficient funds = can be call buy ok
          //timeout = can be call buy ok
          hasCheckBeforeStart = false;
        });
      } else {
        sendMessage('noTrade', `${LOG_PREFIX} not enough volatility for trade (buy: ${buyPrice}, sell: ${sellPrice})`);
      }
    });
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
