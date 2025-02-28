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
        'openpgp'
    ]
};
