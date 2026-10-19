'use strict';

class UserCache {
    constructor(options) {
        this.users = options.users;
        this.redis = options.redis;
        this.settingsHandler = options.settingsHandler;
    }

    flush(user, callback) {
        this.redis.del('cached:' + user, () => callback());
    }

    getDefaultValue(defaultValue, callback) {
        if (defaultValue && typeof defaultValue === 'object' && defaultValue.setting && typeof defaultValue.setting === 'string') {
            this.settingsHandler
                .get(defaultValue.setting)
                .then(value => {
                    callback(null, value);
                })
                .catch(err => callback(err));
            return;
        }

        callback(null, defaultValue);
    }

    get(user, key, defaultValue, callback) {
        this.redis.hget('cached:' + user, key, (err, value) => {
            if (err) {
                return callback(err);
            }

            if (value) {
                return callback(null, Number(value));
            }

            this.users.collection('users').findOne(
                {
                    _id: user
                },
                {
                    projection: {
                        [key]: true
                    }
                },
                (err, userData) => {
                    if (err) {
                        return callback(err);
                    }

                    if (!userData || !userData[key]) {
                        return this.getDefaultValue(defaultValue, callback);
                    }

                    value = userData[key];
                    this.redis
                        .multi()
                        .hset('cached:' + user, key, value)
                        .expire('cached:' + user, 3600)
                        .exec(err => {
                            if (err) {
                                return callback(err);
                            }
                            return callback(null, value);
                        });
                }
            );
        });
    }
}

module.exports = UserCache;
