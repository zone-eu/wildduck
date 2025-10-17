'use strict';

const config = require('@zone-eu/wild-config');
const fs = require('fs');
const db = require('./db');
const CertHandler = require('./cert-handler');
const { buildCertChain } = require('./tools');

const certs = new Map();
const servers = [];

let certHandler;

module.exports.reload = () => {
    // load certificate files
    [false, 'imap', 'lmtp', 'pop3', 'api', 'api.mobileconfig'].forEach(type => {
        let tlsconf = config.tls;

        if (type) {
            let path = (type + '.tls').split('.');
            tlsconf = config;
            for (let i = 0; i < path.length; i++) {
                let key = path[i];
                if (!tlsconf[key]) {
                    tlsconf = false;
                    break;
                }
                tlsconf = tlsconf[key];
            }
            if (!tlsconf || !tlsconf.key) {
                tlsconf = config.tls;
            }
        }

        if (!tlsconf) {
            return;
        }

        let key, cert, ca, dhparam;

        if (tlsconf.key) {
            key = fs.readFileSync(tlsconf.key, 'ascii');
        }

        if (!key) {
            return;
        }

        if (tlsconf.cert) {
            cert = fs.readFileSync(tlsconf.cert, 'ascii');
        }

        if (tlsconf.dhparam) {
            dhparam = fs.readFileSync(tlsconf.dhparam, 'ascii');
        }

        if (tlsconf.ca) {
            ca = [].concat(tlsconf.ca || []).map(ca => fs.readFileSync(ca, 'ascii'));
            if (!ca.length) {
                ca = false;
            }
        }

        certs.set(type || 'default', {
            key,
            cert,
            ca,
            dhparam
        });
    });

    if (!certs.has('default')) {
        certs.set('default', {
            key: fs.readFileSync(__dirname + '/../certs/example.key', 'ascii'),
            cert: fs.readFileSync(__dirname + '/../certs/example.cert', 'ascii'),
            ca: false
        });
    }
};

module.exports.reload();

module.exports.get = type => (certs.has(type) ? certs.get(type) : certs.get('default')) || false;

module.exports.loadTLSOptions = (serverOptions, name) => {
    Object.keys(config[name].tls || {}).forEach(key => {
        if (!['key', 'cert', 'ca', 'dhparam'].includes(key)) {
            serverOptions[key] = config[name].tls[key];
        }
    });

    let serverCerts = module.exports.get(name);

    if (serverCerts) {
        serverOptions.key = serverCerts.key;
        serverOptions.cert = buildCertChain(serverCerts.cert, serverCerts.ca);

        if (serverCerts.dhparam) {
            serverOptions.dhparam = serverCerts.dhparam;
        }
    }
};

module.exports.registerReload = (server, name) => {
    servers.push({ server, name });
};

module.exports.getContextForServername = async (servername, serverOptions, meta, opts) => {
    if (!certHandler) {
        certHandler = new CertHandler({
            cipher: config.certs && config.certs.cipher,
            secret: config.certs && config.certs.secret,
            database: db.database,
            redis: db.redis,
            users: db.users,
            acmeConfig: config.acme,
            loggelf: opts ? opts.loggelf : false
        });
    }

    return await certHandler.getContextForServername(servername, serverOptions, meta);
};

config.on('reload', () => {
    module.exports.reload();
    servers.forEach(entry => {
        let serverCerts = certs.get(entry.name);
        let certOptions = {};
        if (serverCerts) {
            certOptions.key = serverCerts.key;
            certOptions.cert = buildCertChain(serverCerts.cert, serverCerts.ca);

            if (serverCerts.dhparam) {
                certOptions.dhparam = serverCerts.dhparam;
            }

            entry.server.updateSecureContext(certOptions);
        }
    });
});
