"use strict";

const EventEmitter = require('events');

const ChildMaster = require('../helper/child-workers/child-master');

const join = require('path').join;

module.exports = class KrakenApi extends EventEmitter {
    constructor(key, secret) {
        super();

        const childMaster = new ChildMaster(true, true, {
            key: key,
            secret: secret
        });

        childMaster.on('log', (level, message) => {
            console.log(`${level} ${message}`); //TODO pass to custom logger
        });

        childMaster.createWorker({
            slaveClass: join(__dirname, 'worker')
        });

        this._childMaster = childMaster;
    }

    request (method, params) {
        this._childMaster.controlWorker(null, method, params);
    }
};
