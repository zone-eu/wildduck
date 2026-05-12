/*eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const FilterHandler = require('../lib/filter-handler');

describe('FilterHandler recipient spam overrides', () => {
    const buildPrepared = () => ({
        id: new ObjectId(),
        mimeTree: {
            header: ['From: Alice Example <alice@example.com>'],
            parsedHeader: {
                from: [{ name: 'Alice Example', address: 'alice@example.com' }]
            }
        },
        parsedHeader: {
            from: [{ name: 'Alice Example', address: 'alice@example.com' }]
        },
        headers: [{ key: 'from', value: 'Alice Example <alice@example.com>' }],
        size: 1024,
        msgid: false,
        hdate: false
    });

    const createHandler = ({ filters = [], domainaccessData = false } = {}) => {
        let addOptions;

        const handler = new FilterHandler({
            db: {
                senderDb: {
                    collection() {
                        return {};
                    }
                },
                database: {
                    collection(name) {
                        switch (name) {
                            case 'filters':
                                return {
                                    find() {
                                        return {
                                            sort() {
                                                return {
                                                    async toArray() {
                                                        return filters;
                                                    }
                                                };
                                            }
                                        };
                                    }
                                };

                            case 'messages':
                                return {
                                    async findOne() {
                                        return false;
                                    }
                                };

                            case 'domainaccess':
                                return {
                                    async findOne() {
                                        return domainaccessData;
                                    }
                                };

                            default:
                                return {
                                    async findOne() {
                                        return false;
                                    },
                                    find() {
                                        return {
                                            async toArray() {
                                                return [];
                                            }
                                        };
                                    }
                                };
                        }
                    }
                }
            },
            messageHandler: {
                counters: {
                    ttlcounter(key, ttl, count, callback) {
                        callback(null, false);
                    }
                },
                indexer: {
                    getSize() {
                        return 1024;
                    },
                    getMaildata() {
                        return {
                            attachments: []
                        };
                    }
                },
                async prepareMessageAsync() {
                    return buildPrepared();
                },
                async addAsync(options) {
                    addOptions = options;
                    return {
                        data: {
                            mailbox: new ObjectId(),
                            mailboxPath: options.specialUse === '\\Junk' ? 'Junk' : 'INBOX',
                            uid: 1,
                            id: new ObjectId(),
                            size: 1024
                        }
                    };
                }
            },
            sender: {
                collection: 'maildrop'
            },
            loggelf() {
                return false;
            }
        });

        return {
            handler,
            getAddOptions() {
                return addOptions;
            }
        };
    };

    const runCase = async ({ overrideFlags, spamLevel = 50, spamAction = 'no action', filters = [], domainaccessData = false, tagsview = [] }) => {
        const { handler, getAddOptions } = createHandler({ filters, domainaccessData });
        const userData = {
            _id: new ObjectId(),
            address: 'recipient@example.com',
            spamLevel,
            encryptMessages: false,
            autoreply: false,
            tagsview
        };

        const result = await handler.storeMessage(userData, {
            recipient: userData.address,
            sender: 'alice@example.com',
            raw: Buffer.from('Subject: Override test\r\n\r\nHello world\r\n'),
            meta: {
                spamAction,
                overrides: overrideFlags
                    ? {
                          flags: overrideFlags
                      }
                    : false
            }
        });

        return {
            addOptions: getAddOptions(),
            result
        };
    };

    const getSpamResult = result => result.response.filterResults.find(entry => 'spam' in entry);

    it('should force ham to INBOX even when spamLevel would mark the message as spam', async () => {
        const { addOptions, result } = await runCase({
            overrideFlags: ['ham'],
            spamLevel: 0
        });

        expect(addOptions.path).to.equal('INBOX');
        expect(addOptions.specialUse).to.not.exist;
        expect(result.response.filterResults.some(entry => entry.spam === true)).to.equal(false);
        expect(getSpamResult(result)).to.deep.equal({ spam: false, originalSpam: true });
    });

    it('should not let ham override an earlier spam filter action', async () => {
        const { addOptions, result } = await runCase({
            overrideFlags: ['ham'],
            filters: [
                {
                    _id: new ObjectId(),
                    query: {
                        headers: {
                            from: 'alice@example.com'
                        }
                    },
                    action: {
                        spam: true
                    }
                }
            ]
        });

        expect(addOptions.specialUse).to.equal('\\Junk');
        expect(addOptions.path).to.not.exist;
        expect(result.response.filterResults.some(entry => entry.spam === true)).to.equal(true);
        expect(getSpamResult(result)).to.deep.equal({ spam: true });
    });

    it('should not let spam override an earlier ham filter action', async () => {
        const { addOptions, result } = await runCase({
            overrideFlags: ['spam'],
            filters: [
                {
                    _id: new ObjectId(),
                    query: {
                        headers: {
                            from: 'alice@example.com'
                        }
                    },
                    action: {
                        spam: false
                    }
                }
            ]
        });

        expect(addOptions.path).to.equal('INBOX');
        expect(addOptions.specialUse).to.not.exist;
        expect(result.response.filterResults.some(entry => entry.spam === true)).to.equal(false);
        expect(getSpamResult(result)).to.not.exist;
    });

    it('should prefer ham when mixed with spam-like override flags', async () => {
        const { addOptions } = await runCase({
            overrideFlags: ['blacklist', 'ham']
        });

        expect(addOptions.path).to.equal('INBOX');
        expect(addOptions.specialUse).to.not.exist;
    });

    it('should force spam to Junk even when spamLevel would always accept the message', async () => {
        const { addOptions, result } = await runCase({
            overrideFlags: ['spam'],
            spamLevel: 100
        });

        expect(addOptions.specialUse).to.equal('\\Junk');
        expect(addOptions.path).to.not.exist;
        expect(result.response.filterResults.some(entry => entry.spam === true)).to.equal(true);
        expect(getSpamResult(result)).to.deep.equal({ spam: true, originalSpam: false });
    });

    it('should let ham override domainaccess block action', async () => {
        const { addOptions, result } = await runCase({
            overrideFlags: ['ham'],
            tagsview: ['tenant-a'],
            domainaccessData: {
                _id: new ObjectId(),
                tag: 'tenant-a',
                domain: 'example.com',
                action: 'block'
            }
        });

        expect(addOptions.path).to.equal('INBOX');
        expect(addOptions.specialUse).to.not.exist;
        expect(result.response.filterResults.some(entry => entry.spam === true)).to.equal(false);
        expect(getSpamResult(result)).to.deep.equal({ spam: false, originalSpam: true });
    });

    it('should let spam override domainaccess allow action', async () => {
        const { addOptions, result } = await runCase({
            overrideFlags: ['spam'],
            tagsview: ['tenant-a'],
            domainaccessData: {
                _id: new ObjectId(),
                tag: 'tenant-a',
                domain: 'example.com',
                action: 'allow'
            }
        });

        expect(addOptions.specialUse).to.equal('\\Junk');
        expect(addOptions.path).to.not.exist;
        expect(result.response.filterResults.some(entry => entry.spam === true)).to.equal(true);
        expect(getSpamResult(result)).to.deep.equal({ spam: true, originalSpam: false });
    });

    it('should force softlist to Junk', async () => {
        const { addOptions } = await runCase({
            overrideFlags: ['softlist']
        });

        expect(addOptions.specialUse).to.equal('\\Junk');
        expect(addOptions.path).to.not.exist;
    });

    it('should force blacklist to Junk', async () => {
        const { addOptions } = await runCase({
            overrideFlags: ['blacklist']
        });

        expect(addOptions.specialUse).to.equal('\\Junk');
        expect(addOptions.path).to.not.exist;
    });
});
