"use strict";

const ipcHelper = require('../ipc-helper');

const sendMessage = ipcHelper.sendMessage;
const sendLogMessage = ipcHelper.sendLogMessage;
const sendApiMessage = ipcHelper.sendApiMessage;

let slave = null;

process.on('message', (message) => {
    const data = message.data;

    switch (message.type) {
        case 'startup':
            const SlaveClass = require(data.childParams.slaveClass);
            slave = new SlaveClass(data.childOptions, data.childParams);

            slave.once('ready', () => {
                sendMessage('ready', 'ready to rock :)');
                sendLogMessage('verbose', 'ready');
            });

            slave.on('teardown', () => {
                process.exit(0);
            });

            slave.on('data', (data) => {
                sendMessage('data', `got data`, data);
            });

            slave.on('api', (method, params) => {
                sendApiMessage(method, params);
            });

            slave.startup();

            break;
        case 'data':
            slave.handleData(data);
            break;
        case 'control':
            slave.control(data);
            break;
    }
});
