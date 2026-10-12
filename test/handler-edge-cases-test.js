/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const { EventEmitter } = require('events');
const { ObjectId } = require('mongodb');
const FilterHandler = require('../lib/filter-handler');
const updatesRoutes = require('../lib/api/updates');

const expect = chai.expect;

// Unit tests with stubbed collections, no database or server needed
describe('Handler edge cases', function () {
    describe('FilterHandler.getUserDataAsync', () => {
        const userId = new ObjectId();

        const getHandler = addressData => {
            const handler = Object.create(FilterHandler.prototype);
            const results = {
                addresses: () => addressData,
                users: query => ({ _id: query._id, name: 'Recipient' })
            };
            handler.db = { users: { collection: name => ({ findOne: async query => results[name](query) }) } };
            return handler;
        };

        it('resolves the user that owns the address', async () => {
            const userData = await getHandler({ user: userId }).getUserDataAsync('recipient@example.com');
            expect(userData).to.deep.equal({ _id: userId, name: 'Recipient' });
        });

        it('returns false for an unknown address', async () => {
            expect(await getHandler(null).getUserDataAsync('nobody@example.com')).to.be.false;
        });
    });

    describe('GET /users/:user/updates', () => {
        it('does not register a notifier listener when the client disconnects during the journal lookup', async () => {
            const userId = new ObjectId();
            const socket = Object.assign(new EventEmitter(), { destroyed: false, remoteAddress: '127.0.0.1', setTimeout() {} });

            const db = {
                users: { collection: () => ({ findOne: async () => ({ _id: userId, username: 'gone' }) }) },
                database: {
                    collection: () => ({
                        findOne: async () => {
                            socket.destroyed = true;
                            socket.emit('close');
                            return null;
                        }
                    })
                }
            };

            const added = [];
            const notifier = { addListener: (session, fn) => added.push(fn), removeListener() {} };

            const writes = [];
            const raw = { write: data => writes.push(data) };

            const routes = [];
            updatesRoutes(db, { route: options => routes.push(options), beginRawResponse: () => raw }, notifier);

            await routes[0].handler(
                {
                    params: { user: userId.toString() },
                    headers: {},
                    raw: { socket },
                    user: userId.toString(),
                    role: 'root',
                    validate: () => {}
                },
                { raw }
            );

            expect(added).to.be.empty;
            expect(writes).to.be.empty;
        });
    });
});
