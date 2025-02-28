'use strict';

const Joi = require('joi');
const tools = require('../tools');
const { successRes } = require('../schemas/response/general-schemas');

module.exports = (db, server, loggelf) => {
    server.get(
        {
            path: '/health',
            summary: 'Check the health of the API',
            description: 'Check the status of the WildDuck API service, that is if db is connected and readable/writable, same for redis.',
            tags: ['Health'],
            name: 'getHealth',
            validationObjs: {
                requestBody: {},
                queryParams: {},
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({ success: successRes }).$_setFlag('objectName', 'SuccessResponse')
                    },
                    500: {
                        description: 'Failed',
                        model: Joi.object({
                            success: successRes,
                            message: Joi.string().required().description('Error message specifying what went wrong').$_setFlag('objectName', 'ErrorResponse')
                        })
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const currentTimestamp = Math.round(Date.now() / 1000).toString();

            // 1) test that mongoDb is up
            try {
                const pingResult = await db.database.command({ ping: 1 });

                if (!pingResult.ok) {
                    res.status(500);
                    return res.json({
                        success: false,
                        message: 'DB is down'
                    });
                }
            } catch (err) {
                loggelf({
                    short_message: '[HEALTH] MongoDb is down. MongoDb is not connected. PING not ok'
                });

                res.status(500);
                return res.json({
                    success: false,
                    message: 'DB is down'
                });
            }

            // 2) test that mongoDb is writeable

            try {
                const insertData = await db.database.collection('health').insertOne({ [`${currentTimestamp}`]: 'testWrite' });
                await db.database.collection('health').deleteOne({ _id: insertData.insertedId });
            } catch (err) {
                loggelf({
                    short_message:
                        '[HEALTH] could not write to MongoDb. MongoDB is not writeable, cannot write document to collection `health` and delete the document at that path.'
                });

                res.status(500);
                return res.json({
                    success: false,
                    message: 'Could not write to DB'
                });
            }

            // 3) test redis PING
            try {
                // Redis might try to reconnect causing a situation where given ping() command might never return a value, add a fixed timeout
                await promiseRaceTimeoutWrapper(db.redis.ping(), 10000);
            } catch (err) {
                loggelf({
                    short_message: '[HEALTH] Redis is down. PING to Redis failed.'
                });

                res.status(500);
                return res.json({
                    success: false,
                    message: 'Redis is down'
                });
            }

            // 4) test if redis is writeable
            try {
                await promiseRaceTimeoutWrapper(db.redis.hset('health', `${currentTimestamp}`, `${currentTimestamp}`), 10000);

                const data = await promiseRaceTimeoutWrapper(db.redis.hget(`health`, `${currentTimestamp}`), 10000);

                if (data !== `${currentTimestamp}`) {
                    throw Error('Received data is not the same!');
                }

                await promiseRaceTimeoutWrapper(db.redis.hdel('health', `${currentTimestamp}`), 10000);
            } catch (err) {
                loggelf({
                    short_message:
                        '[HEALTH] Redis is not writeable/readable. Could not set hashkey `health` in redis, failed to get the key and/or delete the key.'
                });

                res.status(500);
                return res.json({
                    success: false,
                    message: 'Redis is not writeable/readable'
                });
            }

            res.status(200);
            return res.json({ success: true });
        })
    );
};

async function promiseRaceTimeoutWrapper(promise, timeout) {
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('Async call timed out!')), timeout);
        })
    ]);
}
