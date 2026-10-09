'use strict';

class UserCache {
    constructor(options) {
        this.users = options.users;
        this.redis = options.redis;
        this.settingsHandler = options.settingsHandler;
    }

    /**
     * Drops the cached values of a user. A failed delete is ignored, the entry expires on its own
     */
    async flushAsync(user) {
        try {
            await this.redis.del('cached:' + user);
        } catch {
            // ignore
        }
    }

    flush(user, callback) {
        this.flushAsync(user).then(() => callback());
    }

    async getDefaultValue(defaultValue) {
        if (defaultValue && typeof defaultValue === 'object' && defaultValue.setting && typeof defaultValue.setting === 'string') {
            return await this.settingsHandler.get(defaultValue.setting);
        }

        return defaultValue;
    }

    /**
     * Returns a numeric user setting, cached in Redis for an hour
     *
     * @param {ObjectId} user User ID
     * @param {String} key Field name in the users collection
     * @param {*} defaultValue Value when the field is empty, `{ setting }` reads a system setting
     */
    async getAsync(user, key, defaultValue) {
        let value = await this.redis.hget('cached:' + user, key);
        if (value) {
            return Number(value);
        }

        let userData = await this.users.collection('users').findOne(
            {
                _id: user
            },
            {
                projection: {
                    [key]: true
                }
            }
        );

        if (!userData || !userData[key]) {
            return await this.getDefaultValue(defaultValue);
        }

        value = userData[key];
        await this.redis
            .multi()
            .hset('cached:' + user, key, value)
            .expire('cached:' + user, 3600)
            .exec();

        return value;
    }

    get(user, key, defaultValue, callback) {
        this.getAsync(user, key, defaultValue).then(value => callback(null, value), callback);
    }
}

module.exports = UserCache;
