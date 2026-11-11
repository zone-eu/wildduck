'use strict';

// Core/echo (RFC 8620 4.1)

const { URN } = require('../capabilities');

module.exports = {
    capability: URN.core,
    methods: {
        'Core/echo': async args => args
    }
};
