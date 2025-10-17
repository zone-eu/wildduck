'use strict';

const config = require('@zone-eu/wild-config');
const db = require('./db');
const Maildropper = require('./maildropper');

let maildropper;

module.exports = (options, callback) => {
    maildropper =
        maildropper ||
        new Maildropper({
            db,
            zone: config.sender.zone,
            collection: config.sender.collection,
            gfs: config.sender.gfs,
            loopSecret: config.sender.loopSecret
        });

    return maildropper.push(options, callback);
};
