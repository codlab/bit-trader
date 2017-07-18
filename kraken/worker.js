"use strict";

const EventEmitter = require('events');

const ChildSlave = require('../helper/child-workers/child-slave');
const KrakenWrapper = require('./api');

const sendLogMessage = require('../helper/ipc-helper').sendLogMessage;

module.exports = class ApiWorker extends ChildSlave(EventEmitter) {
    constructor(options = {}) {
        super();

        this._api = new KrakenWrapper(options.key, options.secret);
    }

    getTickForPair(pair) {
        return this._api.getTickForPair(pair);
    }

    control(data) {
        const action = data.action;

        switch (action) {
            case 'tick':
                sendLogMessage('verbose', 'got tick request');
                this.getTickForPair(data.params.pair).then((tickInfo) => {
                    this.emit('data', {
                        namespace: data.params.namespace,
                        data: tickInfo
                    });
                });
                break;
            default:
                sendLogMessage('info', action);
                break;
        }
    }
};
