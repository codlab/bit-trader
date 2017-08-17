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

var holders = [];

function createHolder(options) {
  return {
    options: options,
    inErrorSellAmountCoun : 0,
    openOrder: {id: null, sellPrice: 0, sellAmount: 0},
    cumulativeProfit: 0,
    isInTrade: false,

    hasCheckBeforeStart: false,
    isInCheckBeforeStart: false,

    currentModeOnStartup: MODE_SELL_FROM_CURRENT_BUY,

    stopped: false,

    isWaiting: false,
    waitingUntil: undefined
  }
}

function resetOpenOrder(holder) {
  holder.openOrder = {id: null, sellPrice: 0, sellAmount: 0};
  holder.isInTrade = false;
}

function callbackWhenBuyIsOk(holder) {
  return new Promise((resolve, reject) => {
    api.getTradableVolume().then((pairs) => {
      return _.get(pairs, pair.crypto);
    })
    .then((maxTradeableCrypto) => {
      var sellAmount = holder.openOrder.sellAmount;

      if(sellAmount > maxTradeableCrypto) {
        var previousSellAmount = sellAmount;
        sellAmount = maxTradeableCrypto;
        sendMessage('sell', `${LOG_PREFIX} can not sell ${previousSellAmount}, fixed to ${sellAmount}`);

        if(sellAmount === 0) {
          holder.inErrorSellAmountCount ++;

          if(holder.inErrorSellAmountCount > 4) {
            sendMessage('sell', `${LOG_PREFIX} can not sell for more than 4 times, try reset`);
            resetOpenOrder(holder);
            holder.inErrorSellAmountCount = 0;
          }
        }
      }

      api.execTrade(pair.pair, 'sell', 'limit', holder.openOrder.sellPrice, sellAmount).then((oId) => {
        holder.openOrder = {id: oId};
        sendMessage('sell', `${LOG_PREFIX} buy order fulfilled`);
        resolve();
      })
      .catch(err => {
        //we have an issue... check for cause
        holder.hasCheckBeforeStart = false;
        reject(err);
      });
    })
    .catch(err => {
      reject(err);
    });
  });
}

function manageCurrentWaitingTransaction(holder) {
  return new Promise((resolve, reject) => {
    api.getOrderInfo(holder.openOrder.id).then((orderInfo) => {
      if (orderInfo.status === 'closed') {
        if (orderInfo.type === 'sell') {
          resetOpenOrder(holder);

          sendMessage('fin', `${LOG_PREFIX} sell fulfilled`);

          if(!isNaN(holder.options.waitFor) && Number(holder.options.waitFor) > 0) {
            const waitFor = Number(holder.options.waitFor);
            holder.waitingUntil = moment().add(waitFor, "minutes");
            holder.isWaiting = true;

            sendMessage('fin', `${LOG_PREFIX} waiting for ${waitFor} minutes`);
          }
          resolve();
        } else if (orderInfo.type === 'buy') {
          callbackWhenBuyIsOk(holder)
          .then(() => {
            resolve();
          })
          .catch(err => {
            reject(err);
          });
        }
      } else if (orderInfo.status === 'open') {
        sendMessage('waiting', `${LOG_PREFIX} waiting for orders to fulfill ${holder.openOrder.id}`);
        resolve();
      } else if (orderInfo.status === "partial") {
        sendMessage("waiting", `${LOG_PREFIX} transaction is now partial`);
        resolve();
      } else if (orderInfo.status === "canceled") {
        api.getOrderInfo(holder.openOrder.id)
        .then(orderInfo => {
          if(orderInfo) {
            if(orderInfo.reason && orderInfo.reason === "Out of funds") {
              //force managed possible funds !
              sendMessage("fin", `${LOG_PREFIX} order canceled but out of funds, must be because was bought but issue with kraken`);
              callbackWhenBuyIsOk(holder)
              .then(() => {
                resolve();
              })
              .catch(err => {
                reject(err);
              })
            } else {
              const order = holder.orderInfo;
              resetOpenOrder(holder);

              if(orderInfo.reason && orderInfo.reason === "User canceled") {
                sendMessage('fin', `${LOG_PREFIX} canceled by user - manual management`);
              } else {
                sendMessage('fin', `${LOG_PREFIX} canceled - manual management to do := `+orderInfo.reason);
              }

              resolve();
            }
          } else {
            resolve();
          }
        })
      }
    });
  });
}

function createBuyTransaction(holder, current, volatility) {
  return new Promise((resolve, reject) => {
    holder.inErrorSellAmountCount = 0;

    let buyPrice = floor(current - current * (1. * holder.options.microPercent / 100), MAX_DECIMAL_ACCURACY);
    let buyAmount = floor(holder.options.maxMoneyToUse / buyPrice, MAX_DECIMAL_ACCURACY);
    let buyValue = buyPrice * buyAmount;

    //sell at current price * (100%+microPercent)
    let sellPrice = floor(current + current * (1. * holder.options.multiplicator * holder.options.microPercent / 100), MAX_DECIMAL_ACCURACY);

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

        if(maxTradeableMoney) holder.hasCheckBeforeStart = false;
        else {
          api.getTradableVolume().then((pairs) => {
            return _.get(pairs, pair.crypto);
          })
          .then((maxCryptoTradeableMoney) => {

            api.getClosedOrders().then((orders) => {
              var found = undefined
              _.forIn(orders, order => {
                var exists = false;
                _.forIn(holders, h => {
                  if(h.openOrder && h.openOrder.id === order.id) exists = true;
                });

                if(!exists && order.pair === pair.pair_short) {
                  if(!found || found.closetm < order.closetm) {
                    found = order;
                  }
                }
              });

              if(found) {
                const buyPrice = found.price;
                const buyAmount = found.amount;

                const sellPrice = round((1.0 + holder.options.multiplicator * holder.options.microPercent / 100) * buyPrice / (1.0 - holder.options.multiplicator * holder.options.microPercent / 100), MAX_DECIMAL_ACCURACY);

                holder.openOrder = {
                  id: found.id,
                  sellPrice: sellPrice,
                  sellAmount: buyAmount
                };
                holder.isInTrade = true;

                callbackWhenBuyIsOk(holder)
                .then(() => {
                  resolve();
                })
                .catch((err) => {
                  reject(err);
                });
              }
            })
          })
          .catch(() => {
            resolve();
          })
        }
      }else if (buyPrice >= maxMinPrice && sellPrice <= maxMaxPrice) {
        holder.isInTrade = true;

        api.execTrade(pair.pair, 'buy', 'limit', buyPrice, buyAmount).then((oId) => {
          holder.openOrder = {
            id: oId,
            sellPrice: sellPrice,
            sellAmount: buyAmount,
          };

          let profit = round((sellPrice - buyPrice) * buyAmount, MAX_DECIMAL_ACCURACY);
          holder.cumulativeProfit = holder.cumulativeProfit + profit;

          sendMessage('buy', `${LOG_PREFIX} creating buy order (b:${buyPrice}, s:${sellPrice}, p: ${profit}, cP: ${holder.cumulativeProfit})`, holder.openOrder);
          resolve();
        })
        .catch(err => {
          //we must check whether we have the buy order ok...
          holder.hasCheckBeforeStart = false;
          reject(err);
        });
      } else {
        sendMessage('noTrade', `${LOG_PREFIX} not enough volatility for trade (buy: ${buyPrice}, sell: ${sellPrice})`);
        resolve();
      }
    })
    .catch(err => {
      reject(err);
    });
  });
}

function manageStartupTrade(holder) {
  return new Promise((resolve, reject) => {
    if(!holder.isInCheckBeforeStart) {
      holder.isInCheckBeforeStart = true;

      api.getOpenOrders().then(orders => {
        if(holder.currentModeOnStartup === MODE_ERASE_CURRENT_BUY) {
          _.forIn(orders, (order) => {
            if(order && order.pair === pair.pair_short && order.type === "buy") {
              api.cancelOrder(order.id).then(() => {
                sendMessage('buy', `${LOG_PREFIX} tx ${order.id} is at least canceling`);
              }).catch(e => {
                reject(err);
              });
            }
          });
        } else if(holder.currentModeOnStartup === MODE_SELL_FROM_CURRENT_BUY) {
          var buy_found = false;
          _.forIn(orders, (order) => {
            var exists = false;
            _.forIn(holders, h => {
              if(h.openOrder && h.openOrder.id === order.id) exists = true;
            })

            if(!exists && order && order.pair === pair.pair_short && order.type === "buy") {
              buy_found = true;
              const buyPrice = order.price;
              const buyAmount = order.amount;

              const sellPrice = round((1.0 + holder.options.multiplicator * holder.options.microPercent / 100) * buyPrice / (1.0 - holder.options.multiplicator * holder.options.microPercent / 100), MAX_DECIMAL_ACCURACY);

              holder.openOrder = {
                id: order.id,
                sellPrice: sellPrice,
                sellAmount: buyAmount
              };
              holder.isInTrade = true;
              sendMessage('buy', `${LOG_PREFIX} tx for BUY was set before. We use it as a base`);
            }
          });


          if(!buy_found) {
            //if we did not find a buy order, we also check if we have a sell in progress
            //it can happens when crash in the app or buy passed but info did not come
            _.forIn(orders, (order) => {
              var exists = false;
              _.forIn(holders, h => {
                if(h.openOrder && h.openOrder.id === order.id) exists = true;
              })

              if(!exists && order && order.pair === pair.pair_short && order.type === "sell") {
                holder.openOrder = { id: order.id };
                holder.isInTrade = true;
                sendMessage('buy', `${LOG_PREFIX} tx for SELL was set before. We use it as a base`);
              }
            });
          }
        }

        holder.hasCheckBeforeStart = true;
        holder.isInCheckBeforeStart = false;

        //since we applied the error management
        //we will use this callback whenever we have an issue with buy calls !
        holder.currentModeOnStartup = MODE_SELL_FROM_CURRENT_BUY;
        resolve();
      }).catch((err) => {
        holder.hasCheckBeforeStart = true;
        holder.isInCheckBeforeStart = false;
        reject(err);
      });
    }
  });
}

function inWaitingBlock(holder) {
  return new Promise((resolve, reject) => {
    if(moment().isAfter(holder.waitingUntil)) {
      holder.isWaiting = false;
      sendMessage('buy', `${LOG_PREFIX} wait time finished, restarting`);
    } else {
      sendMessage('buy', `${LOG_PREFIX} waiting`);
    }
    //done synchronically
    resolve();
  });
}


function trade(holder, current, volatility) {
  return new Promise((resolve, reject) => {
    var promise = undefined;
    if(!holder.waitingUntil) holder.isWaiting = false;

    if(holder.isWaiting) {
      promise = inWaitingBlock(holder);
    } else if(holder.stopped) {
      //STOP RIGHT HERE
      //TODO implement?
    } else if(!holder.hasCheckBeforeStart) {
      promise = manageStartupTrade(holder);
    } else if (holder.isInTrade && holder.openOrder && holder.openOrder.id) {
      promise = manageCurrentWaitingTransaction(holder);
    } else {
      promise = createBuyTransaction(holder, current, volatility);
    }

    if(promise) {
      promise.then(() => {
        resolve();
      })
      .catch((err) => {
        reject(err);
      })
    } else {
      reject("promise null");
    }
  });
}

function manageTrade(current, volatility, i = 0) {
  if(i < holders.length) {
    const next = () => {
      i++;
      manageTrade(current, volatility, i);
    }
    trade(holders[i], current, volatility)
    .then(() => {
      next();
    })
    .catch((err) => {
      console.log(err);
      next();
    })
  }
}

process.on('message', (message) => {
  const data = message.data;

  switch (message.type) {
    case 'startup':
    var options = [];
    api = new KrakenWrapper(data.key, data.secret);
    pair = data.pair;
    if(data.options.constructor === Array) {
      options = data.options;
    } else {
      options.push(data.options);
    }
    _.forIn(options, opts => {
      holders.push(createHolder(opts));
    });

    api.getTradableVolume()
    .then(() => {

    });

    LOG_PREFIX = `${LOG_PREFIX} ${pair.pair}`;
    sendMessage('ready', `${LOG_PREFIX} ready`);
    break;

    case 'analyze':
    manageTrade(data.current, data.volatility);
    break;
  }
});
