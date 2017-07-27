module.exports = {
    ipc: require('./ipc-helper'),
    round: function (amount, digits = 5) {
        const multiplicator = Math.pow(10, digits);

        amount = parseFloat((amount * multiplicator).toFixed(11));

        return Number((Math.round(amount) / multiplicator).toFixed(digits));
    },
    ceil: function (amount, digits = 5) {
        const multiplicator = Math.pow(10, digits);

        amount = parseFloat((amount * multiplicator).toFixed(11));

        return Number((Math.ceil(amount) / multiplicator).toFixed(digits));
    },
    floor: function (amount, digits = 5) {
        const multiplicator = Math.pow(10, digits);

        amount = parseFloat((amount * multiplicator).toFixed(11));

        return Number((Math.floor(amount) / multiplicator).toFixed(digits));
    }
};
