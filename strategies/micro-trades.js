"use strict";

const _ = require('lodash'),
moment = require("moment"),
helper = require('../helper'),
KrakenWrapper = require('../kraken'),
Strategy = require("./index.js"),
EventEmitter = require('events');

const round = helper.round;
const ceil = helper.ceil;
const floor = helper.floor;

const MINIMUM_VOLUME_TO_SELL_OR_BUY = 0
const MAX_DECIMAL_ACCURACY = 2;//3;//5;
//TODO transform MAX_DECIMAL_ACCURACY to getMaxDecimalAccuracyFor(devise)
//hence, this value should be read from the kraken.json file

const MODE_ERASE_CURRENT_BUY = "MODE_ERASE_CURRENT_BUY";
const MODE_SELL_FROM_CURRENT_BUY = "MODE_SELL_FROM_CURRENT_BUY";


module.exports = class MicroTrade extends Strategy {


  constructor(api, key, decimals) {
    super(api, key);

    this.decimals = [];
    _.forIn(decimals, (pair) => {
      const value = parseInt(pair.decimals);
      if(!isNaN(value)) {
        this.decimals[pair.devise] = parseInt(pair.decimals);
      }
    });

    this.LOG_PREFIX = '<bit-trader:trader/micro-trades>';
    this.pair = {
      crypto: "",
      fiat: "",
      pair: "",
      pair_short: ""
    };
    this.holders = [];

    this.on('message', (message) => {
      const data = message.data;

      switch (message.type) {
        case 'startup':
        var options = [];
        this.api = new KrakenWrapper(data.key, data.secret);
        this.pair = data.pair;
        if(data.options.constructor === Array) {
          options = data.options;
        } else {
          options.push(data.options);
        }
        _.forIn(options, opts => {
          this.holders.push(this.createHolder(opts));
        });

        this.LOG_PREFIX = `${this.LOG_PREFIX} ${this.pair.pair}`;
        this.sendMessage('ready', `${this.LOG_PREFIX} ready`);
        break;

        case 'analyze':
        this.manageTrade(data.current, data.volatility);
        break;
      }
    });
  }

  getMaxDecimalAccuracyFor(devise) {
    if(this.decimals[devise]) {
      return this.decimals[devise];
    } else {
      this.sendMessage('error', `${this.LOG_PREFIX} error with decimal accuracy for ${devise}, please set its maximum decimals`);
      return MAX_DECIMAL_ACCURACY; //DEFAULT
    }
  }


  createHolder (options) {
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

  resetOpenOrder (holder) {
    holder.openOrder = {id: null, sellPrice: 0, sellAmount: 0};
    holder.isInTrade = false;
  }

  callbackWhenBuyIsOk (holder) {
    return new Promise((resolve, reject) => {
      this.api.getTradableVolume().then((pairs) => {
        return _.get(pairs, this.pair.crypto);
      })
      .then((maxTradeableCrypto) => {
        var sellAmount = holder.openOrder.sellAmount;

        if(sellAmount > maxTradeableCrypto) {
          var previousSellAmount = sellAmount;
          sellAmount = maxTradeableCrypto;
          this.sendMessage('sell', `${this.LOG_PREFIX} can not sell ${previousSellAmount}, fixed to ${sellAmount}`);

          if(sellAmount <= MINIMUM_VOLUME_TO_SELL_OR_BUY) {
            holder.inErrorSellAmountCount ++;

            if(holder.inErrorSellAmountCount > 4) {
              this.sendMessage('sell', `${this.LOG_PREFIX} can not sell for more than 4 times, try reset`);
              this.resetOpenOrder(holder);
              holder.inErrorSellAmountCount = 0;
            }
          }
        }

        this.api.execTrade(this.pair.pair, 'sell', 'limit', holder.openOrder.sellPrice, sellAmount).then((oId) => {
          holder.openOrder = {id: oId};
          this.sendMessage('sell', `${this.LOG_PREFIX} buy order fulfilled`);
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

  manageCurrentWaitingTransaction (holder) {
    return new Promise((resolve, reject) => {
      this.api.getOrderInfo(holder.openOrder.id).then((orderInfo) => {
        if (orderInfo.status === 'closed') {
          if (orderInfo.type === 'sell') {
            this.resetOpenOrder(holder);

            this.sendMessage('fin', `${this.LOG_PREFIX} sell fulfilled`);

            if(!isNaN(holder.options.waitFor) && Number(holder.options.waitFor) > 0) {
              const waitFor = Number(holder.options.waitFor);
              holder.waitingUntil = moment().add(waitFor, "minutes");
              holder.isWaiting = true;

              this.sendMessage('fin', `${this.LOG_PREFIX} waiting for ${waitFor} minutes`);
            }
            resolve();
          } else if (orderInfo.type === 'buy') {
            this.callbackWhenBuyIsOk(holder)
            .then(() => {
              resolve();
            })
            .catch(err => {
              reject(err);
            });
          }
        } else if (orderInfo.status === 'open') {
          this.sendMessage('waiting', `${this.LOG_PREFIX} waiting for orders to fulfill ${holder.openOrder.id}`);
          resolve();
        } else if (orderInfo.status === "partial") {
          this.sendMessage("waiting", `${this.LOG_PREFIX} transaction is now partial`);
          resolve();
        } else if (orderInfo.status === "canceled") {
          this.api.getOrderInfo(holder.openOrder.id)
          .then(orderInfo => {
            if(orderInfo) {
              if(orderInfo.reason && orderInfo.reason === "Out of funds") {
                //force managed possible funds !
                this.sendMessage("fin", `${this.LOG_PREFIX} order canceled but out of funds, must be because was bought but issue with kraken`);
                this.callbackWhenBuyIsOk(holder)
                .then(() => {
                  resolve();
                })
                .catch(err => {
                  reject(err);
                })
              } else {
                const order = holder.orderInfo;
                this.resetOpenOrder(holder);

                if(orderInfo.reason && orderInfo.reason === "User canceled") {
                  this.sendMessage('fin', `${this.LOG_PREFIX} canceled by user - manual management`);
                } else {
                  this.sendMessage('fin', `${this.LOG_PREFIX} canceled - manual management to do := `+orderInfo.reason);
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

  createBuyTransaction (holder, current, volatility) {
    return new Promise((resolve, reject) => {
      holder.inErrorSellAmountCount = 0;

      let buyPrice = floor(current - current * (1. * holder.options.microPercent / 100), MAX_DECIMAL_ACCURACY);
      let buyAmount = floor(holder.options.maxMoneyToUse / buyPrice, MAX_DECIMAL_ACCURACY);
      let buyValue = buyPrice * buyAmount;

      //sell at current price * (100%+microPercent)
      let sellPrice = floor(current + current * (1. * holder.options.multiplicator * holder.options.microPercent / 100), MAX_DECIMAL_ACCURACY);

      this.api.getTradableVolume().then((pairs) => {
        return _.get(pairs, this.pair.fiat);
      }).then((maxTradeableMoney) => {
        if (buyValue > maxTradeableMoney) {
          buyAmount = floor(maxTradeableMoney / buyPrice, MAX_DECIMAL_ACCURACY);
        }

        let maxMinPrice = round(current - (buyPrice * volatility), MAX_DECIMAL_ACCURACY);
        let maxMaxPrice = round(current + (buyPrice * volatility), MAX_DECIMAL_ACCURACY);

        buyPrice = floor(buyPrice, MAX_DECIMAL_ACCURACY);
        sellPrice = round(sellPrice, MAX_DECIMAL_ACCURACY);

        if(maxTradeableMoney <= MINIMUM_VOLUME_TO_SELL_OR_BUY || (buyPrice*buyAmount) <= MINIMUM_VOLUME_TO_SELL_OR_BUY) {
          this.sendMessage('noTrade', `${this.LOG_PREFIX} not enough volume to buy (buy: ${buyPrice}, sell: ${sellPrice})`);

          if(maxTradeableMoney > MINIMUM_VOLUME_TO_SELL_OR_BUY) holder.hasCheckBeforeStart = false;
          else {
            this.api.getTradableVolume().then((pairs) => {
              return _.get(pairs, this.pair.crypto);
            })
            .then((maxCryptoTradeableMoney) => {

              this.api.getClosedOrders().then((orders) => {
                var found = undefined
                _.forIn(orders, order => {
                  var exists = false;
                  _.forIn(this.holders, h => {
                    if(h.openOrder && h.openOrder.id === order.id) exists = true;
                  });

                  if(!exists && order.pair === this.pair.pair_short) {
                    if(!found || found.closetm < order.closetm) {
                      found = order;
                    }
                  }
                });

                if(found) {
                  const buyPrice = found.price;
                  const buyAmount = found.amount;

                  const sellPrice = round((1.0 + holder.options.multiplicator * holder.options.microPercent / 100) * buyPrice / (1.0 - holder.options.multiplicator * holder.options.microPercent / 100), MAX_DECIMAL_ACCURACY);


                  console.log("buyPrice", buyPrice);
                  console.log("buyAmount", buyAmount);
                  console.log("sellPrice", sellPrice);

                  holder.openOrder = {
                    id: found.id,
                    sellPrice: sellPrice,
                    sellAmount: buyAmount
                  };
                  holder.isInTrade = true;

                  this.callbackWhenBuyIsOk(holder)
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
          console.log(`${buyAmount}`);

          this.api.execTrade(this.pair.pair, 'buy', 'limit', buyPrice, buyAmount).then((oId) => {
            holder.openOrder = {
              id: oId,
              sellPrice: sellPrice,
              sellAmount: buyAmount,
            };

            let profit = round((sellPrice - buyPrice) * buyAmount, MAX_DECIMAL_ACCURACY);
            holder.cumulativeProfit = holder.cumulativeProfit + profit;

            this.sendMessage('buy', `${this.LOG_PREFIX} creating buy order (b:${buyPrice}, s:${sellPrice}, p: ${profit}, cP: ${holder.cumulativeProfit})`, holder.openOrder);
            resolve();
          })
          .catch(err => {
            //we must check whether we have the buy order ok...
            holder.hasCheckBeforeStart = false;
            reject(err);
          });
        } else {
          this.sendMessage('noTrade', `${this.LOG_PREFIX} not enough volatility for trade (buy: ${buyPrice}, sell: ${sellPrice})`);
          resolve();
        }
      })
      .catch(err => {
        reject(err);
      });
    });
  }

  manageStartupTrade (holder) {
    return new Promise((resolve, reject) => {
      if(!holder.isInCheckBeforeStart) {
        holder.isInCheckBeforeStart = true;

        this.api.getOpenOrders().then(orders => {
          if(holder.currentModeOnStartup === MODE_ERASE_CURRENT_BUY) {
            _.forIn(orders, (order) => {
              if(order && order.pair === this.pair.pair_short && order.type === "buy") {
                this.api.cancelOrder(order.id).then(() => {
                  this.sendMessage('buy', `${this.LOG_PREFIX} tx ${order.id} is at least canceling`);
                }).catch(e => {
                  reject(err);
                });
              }
            });
          } else if(holder.currentModeOnStartup === MODE_SELL_FROM_CURRENT_BUY) {
            var buy_found = false;
            _.forIn(orders, (order) => {
              var exists = false;
              _.forIn(this.holders, h => {
                if(h.openOrder && h.openOrder.id === order.id) exists = true;
              })

              if(!exists && order && order.pair === this.pair.pair_short && order.type === "buy") {
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

                this.sendMessage('buy', `${this.LOG_PREFIX} ${order.id} tx for BUY was set before. We use it as a base`);
              }
            });


            if(!buy_found) {
              //if we did not find a buy order, we also check if we have a sell in progress
              //it can happens when crash in the app or buy passed but info did not come
              _.forIn(orders, (order) => {
                if(!buy_found && order && order.pair === this.pair.pair_short && order.type === "sell") {
                  var exists = false;
                  _.forIn(this.holders, h => {
                    if(h.openOrder && h.openOrder.id === order.id) exists = true;
                  })

                  if(!exists) {
                    holder.openOrder = { id: order.id };
                    holder.isInTrade = true;
                    this.sendMessage('buy', `${this.LOG_PREFIX} ${order.id} tx for SELL was set before. We use it as a base`);
                    buy_found = true; // stop here
                  }
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

  inWaitingBlock (holder) {
    return new Promise((resolve, reject) => {
      if(moment().isAfter(holder.waitingUntil)) {
        holder.isWaiting = false;
        this.sendMessage('buy', `${this.LOG_PREFIX} wait time finished, restarting`);
      } else {
        this.sendMessage('buy', `${this.LOG_PREFIX} waiting`);
      }
      //done synchronically
      resolve();
    });
  }


  trade (holder, current, volatility) {
    return new Promise((resolve, reject) => {
      var promise = undefined;
      if(!holder.waitingUntil) holder.isWaiting = false;

      if(holder.isWaiting) {
        promise = this.inWaitingBlock(holder);
      } else if(holder.stopped) {
        //STOP RIGHT HERE
        //TODO should it be implemented?
      } else if(!holder.hasCheckBeforeStart) {
        promise = this.manageStartupTrade(holder);
      } else if (holder.isInTrade && holder.openOrder && holder.openOrder.id) {
        promise = this.manageCurrentWaitingTransaction(holder);
      } else {
        promise = this.createBuyTransaction(holder, current, volatility);
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


  manageTrade (current, volatility, i = 0) {
    if(i < this.holders.length) {
      const next = () => {
        i++;
        this.manageTrade(current, volatility, i);
      }
      this.trade(this.holders[i], current, volatility)
      .then(() => {
        next();
      })
      .catch((err) => {
        console.log(err);
        next();
      })
    }else {
      console.log(" ");
    }
  }

  sendMessage (type, message, data) {
    this.emit("message", {
      type: type,
      message: message,
      data: data
    })
  }
}
