"use strict";

const _ = require('lodash');
const EventEmitter = require('events');

const ChildSlave = require('../helper/child-workers/child-slave');
const KrakenWrapper = require('../kraken');

const ipcHelper = require('../helper/ipc-helper');
const sendMessage = ipcHelper.sendMessage;
const sendLogMessage = ipcHelper.sendLogMessage;

const abs = Math.abs;

module.exports = class WatcherWorker extends ChildSlave(EventEmitter) {
  constructor(options, params) {
    super(...arguments);

    this._api = new KrakenWrapper(options.key, options.secret);
    this._requestInterval = params.interval;
    this._pair = params.pair;
    this._interval = null;
  }

  start(params) {
    if (params) {
      let newInterval = params.interval;
      let newPair = params.pair;

      if (newInterval && newPair) {
        this._requestInterval = newInterval;
        this._pair = newPair;
      } else {
        sendLogMessage('error', 'cannot updated worker params, because of missing params');
      }
    } else {
      sendLogMessage('info', 'starting to work');
      this._interval = setInterval(this.requestData.bind(this), this._requestInterval);
    }
  }

  stop(params) {
    if (params) {
      sendLogMessage('error', `this worker doesn't support params within the stop action`);
    } else {
      clearInterval(this._interval);
    }
  }

  requestData() {
    this._api.getTickForPair(this._pair).then((data) => {
      return this.prepareData(data);
    }).then((data) => {
      this._api.getOHLCForPair(this._pair).then((infos) => {

        if(data) {
          data.infos = this.prepareHistoricalData(infos);

          const calculated = data.infos.calc_open;
          if(!isNaN(calculated)) {
            data.current = calculated;
          }
        }

        this.emit('data', data);
      }).catch(e => {
        this.emit('data', data);
      })
    });
  }

  prepareHistoricalData(data) {
    const preparedHistoricalData = {
      avg_open: 0,
      avg_count: 0
    };

    if(data && data[this._pair]) {
      const array = data[this._pair];

      var test_count = 0;

      const calc = (last_n) => {
        var i = array.length - last_n;
        if(i < 0) i = 0;
        for(; i < array.length; i++) {
          preparedHistoricalData.avg_open += Number(array[i][1]);
          preparedHistoricalData.avg_count ++;
        }
      }

      calc(20);
      //now do it for the last 5 - once more
      calc(5);
      //and the last 2
      calc(2);

      //now we have :
      //from the end-20 := 1[-20] 1[-19] ... 1[-5] 2[-4] 2[-3] 2[-2] 3[-1] 3[0]
      //avg is based on the cardinal : 20 + 5 + 2 instead of 20
      //to make sure we give more "relevance" to the last values / tendancies
      //quite easily


      const calculated = preparedHistoricalData.avg_open / preparedHistoricalData.avg_count;
      if(!isNaN(calculated)) {
        preparedHistoricalData.calc_open = calculated;
      }
    }

    return preparedHistoricalData;
  }

  prepareData(data) {
    const pair = this._pair;
    data = _.get(data, pair);

    const low = data['l'].map(Number);
    const high = data['h'].map(Number);

    const preparedData = {
      pair: pair,
      low: {
        today: low[0],
        "24h": low[1]
      },
      high: {
        today: high[0],
        "24h": high[1]
      },
      volatility: {
        today: abs(((high[0] - low[0]) / low[0]) * 100),
        "24h": abs(((high[1] - low[1]) / low[1]) * 100)
      },
      current: Number(data['c'][0])
    };

    if(isNaN(preparedData.volatility.today)) {
      preparedData.volatility.today = preparedData.volatility["24h"];
    }
    if(isNaN(preparedData.low.today)) {
      preparedData.low.today = preparedData.low["24h"];
    }
    if(isNaN(preparedData.low.today)) {
      preparedData.low.today = preparedData.low["24h"];
    }



    return preparedData;
  }
};
