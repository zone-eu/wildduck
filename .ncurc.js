module.exports = {
    upgrade: true,
    reject: [
        // mongodb 5.x driver does not support callbacks, only promises
        'mongodb',

        // no support for Node 16
        'undici',

        // esm only
        'chai',
        'unixcrypt',

        // api changes, fix later
        'eslint',
        'grunt-eslint',

        // temporary lock to v5, openpgp v6 is "module" by default, but should be backwards compatible
        'openpgp',

        // esm only since v18, breaks the CommonJS CLI scripts in bin/
        'yargs',

        // 1.0.11 needs @zone-eu/types 0.1.7, which requires the mongodb 7 driver (overrides pin types to 0.1.6)
        '@zone-eu/wild-plugins',

        // new major upgrade requires rewrite
        'mongo-cursor-pagination',
        'accesscontrol',
        'ioredis'
    ]
};
