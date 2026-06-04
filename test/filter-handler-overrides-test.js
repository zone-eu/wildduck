/*eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const FilterHandler = require('../lib/filter-handler');
const plugins = require('../lib/plugins');

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
        let encryptionOptions;

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
                async prepareMessageAsync(options = {}) {
                    let prepared = buildPrepared();
                    if (options.mimeTree) {
                        prepared.mimeTree = options.mimeTree;
                    }
                    return prepared;
                },
                generateIndexedHeaders(headers) {
                    return (headers || []).map(line => {
                        let pos = line.indexOf(':');
                        return {
                            key: line.substr(0, pos).toLowerCase(),
                            value: line.substr(pos + 1).trim()
                        };
                    });
                },
                async encryptMessageAsync(encryptionKey, raw) {
                    encryptionOptions = {
                        encryptionKey,
                        raw
                    };
                    return {
                        raw: Buffer.from('Subject: Encrypted\r\n\r\nEncrypted body\r\n')
                    };
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
            },
            getEncryptionOptions() {
                return encryptionOptions;
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

    it('should return a reusable mimeTree without per-recipient headers', async () => {
        const { handler, getAddOptions } = createHandler();
        const sender = 'alice@example.com';
        const userData = {
            _id: new ObjectId(),
            address: 'recipient@example.com',
            spamLevel: 50,
            encryptMessages: false,
            autoreply: false,
            tagsview: []
        };

        const firstResult = await handler.storeMessage(userData, {
            recipient: userData.address,
            sender,
            raw: Buffer.from('Subject: Reuse test\r\n\r\nHello world\r\n'),
            meta: {}
        });

        expect(getAddOptions().prepared.mimeTree.header.slice(0, 2)).to.deep.equal(['Delivered-To: recipient@example.com', 'Return-Path: <alice@example.com>']);
        expect(firstResult.prepared.mimeTree.header).to.deep.equal(['From: Alice Example <alice@example.com>']);

        const reusableMimeTree = firstResult.prepared.mimeTree;

        await handler.storeMessage(Object.assign({}, userData, { _id: new ObjectId(), address: 'second@example.com' }), {
            recipient: 'second@example.com',
            sender,
            mimeTree: reusableMimeTree,
            maildata: firstResult.prepared.maildata,
            meta: {}
        });

        expect(reusableMimeTree.header).to.deep.equal(['From: Alice Example <alice@example.com>']);
        expect(getAddOptions().prepared.mimeTree.header.slice(0, 2)).to.deep.equal(['Delivered-To: second@example.com', 'Return-Path: <alice@example.com>']);
    });

    it('should pass message:wd_headers header mutations into encryption input', async () => {
        const originalHandler = plugins.handler;
        const { handler, getEncryptionOptions } = createHandler();

        plugins.handler = {
            async runHooks(name, args) {
                if (name === 'message:wd_headers') {
                    let fromHeader = args[0].findIndex(line => /^From:/i.test(line));
                    if (fromHeader >= 0) {
                        args[0].splice(fromHeader, 1);
                    }
                    delete args[1].from;

                    args[0].push('X-WD-Test: encrypted');
                    args[1]['x-wd-test'] = 'encrypted';
                }
            }
        };

        try {
            await handler.storeMessage(
                {
                    _id: new ObjectId(),
                    address: 'recipient@example.com',
                    spamLevel: 50,
                    encryptMessages: true,
                    pubKey: 'test-key',
                    autoreply: false,
                    tagsview: []
                },
                {
                    recipient: 'recipient@example.com',
                    sender: 'alice@example.com',
                    raw: Buffer.from('Subject: Encrypt test\r\n\r\nHello world\r\n'),
                    meta: {}
                }
            );

            const encryptionRaw = getEncryptionOptions().raw.toString();

            expect(encryptionRaw).to.include('X-WD-Test: encrypted');
            expect(encryptionRaw).to.not.include('From: Alice Example <alice@example.com>');
            expect(encryptionRaw).to.not.include('Subject: Encrypt test');
        } finally {
            plugins.handler = originalHandler;
        }
    });

    it('should pass message:wd_headers added headers into encryption input', async () => {
        const originalHandler = plugins.handler;
        const { handler, getEncryptionOptions } = createHandler();

        plugins.handler = {
            async runHooks(name, args) {
                if (name === 'message:wd_headers') {
                    args[0].push('X-WD-Added: one');
                    args[0].push('X-WD-Second: two');
                    args[1]['x-wd-added'] = 'one';
                    args[1]['x-wd-second'] = 'two';
                }
            }
        };

        try {
            await handler.storeMessage(
                {
                    _id: new ObjectId(),
                    address: 'recipient@example.com',
                    spamLevel: 50,
                    encryptMessages: true,
                    pubKey: 'test-key',
                    autoreply: false,
                    tagsview: []
                },
                {
                    recipient: 'recipient@example.com',
                    sender: 'alice@example.com',
                    raw: Buffer.from('Subject: Add test\r\n\r\nHello world\r\n'),
                    meta: {}
                }
            );

            const encryptionRaw = getEncryptionOptions().raw.toString();
            const headerBlock = encryptionRaw.split('\r\n\r\n')[0];

            expect(headerBlock).to.include('X-WD-Added: one');
            expect(headerBlock).to.include('X-WD-Second: two');
            expect(encryptionRaw).to.include('\r\n\r\nHello world\r\n');
        } finally {
            plugins.handler = originalHandler;
        }
    });

    it('should preserve message:wd_headers header reordering in encryption input', async () => {
        const originalHandler = plugins.handler;
        const { handler, getEncryptionOptions } = createHandler();

        plugins.handler = {
            async runHooks(name, args) {
                if (name === 'message:wd_headers') {
                    let fromHeader = args[0].findIndex(line => /^From:/i.test(line));
                    if (fromHeader >= 0) {
                        args[0].unshift(args[0].splice(fromHeader, 1)[0]);
                    }
                }
            }
        };

        try {
            await handler.storeMessage(
                {
                    _id: new ObjectId(),
                    address: 'recipient@example.com',
                    spamLevel: 50,
                    encryptMessages: true,
                    pubKey: 'test-key',
                    autoreply: false,
                    tagsview: []
                },
                {
                    recipient: 'recipient@example.com',
                    sender: 'alice@example.com',
                    raw: Buffer.from('Subject: Move test\r\n\r\nHello world\r\n'),
                    meta: {}
                }
            );

            const headerLines = getEncryptionOptions().raw.toString().split('\r\n\r\n')[0].split('\r\n');

            expect(headerLines.slice(0, 3)).to.deep.equal([
                'From: Alice Example <alice@example.com>',
                'Delivered-To: recipient@example.com',
                'Return-Path: <alice@example.com>'
            ]);
        } finally {
            plugins.handler = originalHandler;
        }
    });
});
