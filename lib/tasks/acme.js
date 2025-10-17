'use strict';

const log = require('npmlog');
const config = require('@zone-eu/wild-config');

let run = async (task, data, options) => {
    const { getCertificate, certHandler } = options;
    let cert = await getCertificate(data.servername, config.acme, certHandler);
    log.verbose('Tasks', 'task=acme id=%s servername=%s status=%s', task._id, data.servername, cert && cert.status);
    return true;
};

module.exports = (task, data, options, callback) => {
    run(task, data, options)
        .then(response => callback(null, response))
        .catch(callback);
};
