/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

const { expect } = require('chai');
const UserHandler = require('../lib/user-handler');

// _asyncAuthenticate only needs these four members up to the point where the lookups happen
function createHandler(overrides) {
    const handler = Object.create(UserHandler.prototype);

    handler.loggelf = () => false;
    handler.rateLimitIP = async () => ({ success: true });
    handler.checkAddress = async () => ({ unameview: 'testuser' });
    handler.users = {
        collection: () => ({
            findOne: async () => false
        })
    };

    return Object.assign(handler, overrides || {});
}

describe('UserHandler authentication', function () {
    const meta = { protocol: 'IMAP', ip: '127.0.0.1', sess: 'test' };

    it('should report a rate limit backend failure as UNAVAILABLE', async () => {
        const handler = createHandler({
            rateLimitIP: async () => {
                throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
            }
        });

        let error;
        try {
            await handler._asyncAuthenticate('testuser', 'secret', 'imap', meta);
        } catch (err) {
            error = err;
        }

        expect(error).to.exist;
        expect(error.code).to.equal('UNAVAILABLE');
        expect(error.response).to.equal('NO');
    });

    it('should report an address lookup failure as UNAVAILABLE', async () => {
        const handler = createHandler({
            checkAddress: async () => {
                throw new Error('connect ECONNREFUSED 127.0.0.1:27017');
            }
        });

        let error;
        try {
            await handler._asyncAuthenticate('testuser@example.com', 'secret', 'imap', meta);
        } catch (err) {
            error = err;
        }

        expect(error).to.exist;
        expect(error.code).to.equal('UNAVAILABLE');
        expect(error.response).to.equal('NO');
    });

    it('should report a user lookup failure as UNAVAILABLE', async () => {
        const handler = createHandler({
            users: {
                collection: () => ({
                    findOne: async () => {
                        throw new Error('connect ECONNREFUSED 127.0.0.1:27017');
                    }
                })
            }
        });

        let error;
        try {
            await handler._asyncAuthenticate('testuser', 'secret', 'imap', meta);
        } catch (err) {
            error = err;
        }

        expect(error).to.exist;
        expect(error.code).to.equal('UNAVAILABLE');
        expect(error.response).to.equal('NO');
    });

    it('should report a rate limit backend failure for an unknown user as UNAVAILABLE', async () => {
        const handler = createHandler({
            rateLimit: async () => {
                throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
            }
        });

        let error;
        try {
            await handler._asyncAuthenticate('testuser', 'secret', 'imap', meta);
        } catch (err) {
            error = err;
        }

        expect(error).to.exist;
        expect(error.code).to.equal('UNAVAILABLE');
        expect(error.response).to.equal('NO');
    });

    it('should still report an unknown user as a plain authentication failure', async () => {
        const handler = createHandler({
            rateLimit: async () => ({ success: true })
        });

        const result = await handler._asyncAuthenticate('testuser', 'secret', 'imap', meta);

        expect(result).to.deep.equal([false, false]);
    });

    it('should still report a missing password as a plain authentication failure', async () => {
        const result = await createHandler()._asyncAuthenticate('testuser', '', 'imap', meta);

        expect(result).to.deep.equal([false, false]);
    });
});
