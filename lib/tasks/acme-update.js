'use strict';

const log = require('npmlog');
const config = require('@zone-eu/wild-config');

let run = async (task, data, options) => {
    const { acquireCert, certHandler } = options;

    try {
        await certHandler.clearGarbage();
    } catch (err) {
        log.error('Tasks', 'task=acme-update id=%s action=clear-garbage error=%s', task._id, err.message);
    }

    let certData;
    while ((certData = await certHandler.getNextRenewal())) {
        let cert = await acquireCert(certData.servername, config.acme, certData, certHandler);
        log.verbose('Tasks', 'task=acme-update id=%s servername=%s status=%s', task._id, certData.servername, cert && cert.status);
    }

    return true;
};

module.exports = (task, data, options, callback) => {
    run(task, data, options)
        .then(response => callback(null, response))
        .catch(callback);
};
