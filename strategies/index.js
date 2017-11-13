"use strict";

const EventEmitter = require('events');
const Pact = require('bluebird');

const fork = require('child_process').fork;
const join = require('path').join;

const LOG_PREFIX = '<bit-trader:trader>';

module.exports = class Strategy extends EventEmitter {
  constructor(key, secret) {
    super();

    if (key && secret) {
      this._apiKey = key;
      this._apiSecret = secret;
      this._workers = {};
    } else {
      throw `${LOG_PREFIX} can not create watcher without api credentials!`;
    }
  }

  init(pair, strategy, options) {
    this.on('message', message => {
      this._messageHandler(message);
    });
    this.on('error', (err) => {
      this._childErrorHandler(err, pair, strategy, options);
    });
    this.on('exit', (code) => {
      this._childExitHandler(code, pair, strategy, options);
    });

    this.emit("message", {
      type: 'startup',
      data: {key: this._apiKey, secret: this._apiSecret, pair: pair, options: options}
    });
  }

  sendDataToWorker(pair, strategy, data) {
    this.emit("message", {
      type: 'analyze',
      data: data,
      pair: pair
    });
  }

  _messageHandler(message) {
    switch (message.type) {
      case 'error':
      console.error(message.message);
      console.error(message.data);
      break;
      case'data':
      console.info(message.message);
      this.emit('data', message.data);
      break;
      default:
      console.info(message.message);
      break;
    }
  }

  _childErrorHandler(err, pair, strategy, options) {
    console.error(`${LOG_PREFIX} child died for pair ${pair}`);
    console.error(err);
    console.error(`${LOG_PREFIX} reviving ${pair} worker`);
  }

  _childExitHandler(code, pair, strategy, options) {
    if (code !== 0) {
      console.error(`${LOG_PREFIX} child (${`${pair}-${strategy}`}) exited unexpected, reviving`);
    } else {
      console.info(`${LOG_PREFIX} child (${`${pair}-${strategy}`}) exited`);
    }
  }
};
