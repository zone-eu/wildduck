/*eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const FilterHandler = require('../lib/filter-handler');
const MessageHandler = require('../lib/message-handler');
const Indexer = require('../imap-core/lib/indexer/indexer');

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

    const readRebuild = async outputStream =>
        await new Promise((resolve, reject) => {
            let chunks = [];
            let chunklen = 0;

            outputStream.value
                .on('data', chunk => {
                    chunks.push(chunk);
                    chunklen += chunk.length;
                })
                .on('end', () => resolve(Buffer.concat(chunks, chunklen)))
                .on('error', reject);
        });

    const createRealIndexerHandler = () => {
        let addOptions;
        let encryptionOptions;
        const indexer = new Indexer();
        const mailboxId = new ObjectId();

        const messageHandler = {
            counters: {
                ttlcounter(key, ttl, count, callback) {
                    callback(null, false);
                }
            },
            indexer,
            async prepareMessageAsync(options = {}) {
                return await MessageHandler.prototype.prepareMessageAsync.call(this, options);
            },
            generateIndexedHeaders(headers) {
                return MessageHandler.prototype.generateIndexedHeaders.call(this, headers);
            },
            normalizeSubject(subject, options) {
                return MessageHandler.prototype.normalizeSubject.call(this, subject, options);
            },
            async getMailboxAsync(options) {
                return {
                    _id: mailboxId,
                    user: options.user,
                    path: 'INBOX',
                    uidValidity: 1
                };
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
                        mailbox: mailboxId,
                        mailboxPath: options.specialUse === '\\Junk' ? 'Junk' : 'INBOX',
                        uid: 1,
                        id: new ObjectId(),
                        size: options.prepared.size
                    }
                };
            }
        };

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
                                                        return [];
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
            messageHandler,
            sender: {
                collection: 'maildrop'
            },
            loggelf() {
                return false;
            }
        });

        return {
            handler,
            indexer,
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

    it('should preserve real indexer maildata and rebuilt body for mimeTree reuse without maildata', async () => {
        const { handler, indexer, getAddOptions } = createRealIndexerHandler();
        const bodyText = 'This is the body text that we want to extract.';
        const raw = Buffer.from(
            [
                'From: Alice Example <alice@example.com>',
                'To: Recipient <recipient@example.com>',
                'Subject: Real reuse',
                'Message-ID: <real-reuse@example.com>',
                'Date: Fri, 05 Jun 2026 12:00:00 +0000',
                '',
                bodyText,
                ''
            ].join('\r\n')
        );
        const reusableMimeTree = indexer.parseMimeTree(raw);

        const result = await handler.storeMessage(
            {
                _id: new ObjectId(),
                address: 'recipient@example.com',
                spamLevel: 50,
                encryptMessages: false,
                autoreply: false,
                tagsview: []
            },
            {
                recipient: 'recipient@example.com',
                sender: 'alice@example.com',
                mimeTree: reusableMimeTree,
                meta: {}
            }
        );

        const addOptions = getAddOptions();
        const rebuilt = await readRebuild(indexer.rebuild(addOptions.prepared.mimeTree));

        expect(Buffer.isBuffer(reusableMimeTree.body)).to.equal(true);
        expect(Buffer.isBuffer(addOptions.prepared.mimeTree.body)).to.equal(true);
        expect(addOptions.maildata.text).to.equal(bodyText);
        expect(result.prepared.maildata.text).to.equal(bodyText);
        expect(rebuilt.toString()).to.include(bodyText);
        expect(result.prepared.mimeTree.header.slice(0, 2)).to.deep.equal(['From: Alice Example <alice@example.com>', 'To: Recipient <recipient@example.com>']);
    });

    it('should rebuild encryption input for mimeTree reuse without raw chunks', async () => {
        const { handler, indexer, getEncryptionOptions } = createRealIndexerHandler();
        const bodyText = 'This body must be present before encryption.';
        const raw = Buffer.from(
            [
                'From: Alice Example <alice@example.com>',
                'To: Recipient <recipient@example.com>',
                'Subject: Encrypt reused tree',
                'Message-ID: <encrypt-reuse@example.com>',
                'Date: Fri, 05 Jun 2026 12:00:00 +0000',
                '',
                bodyText,
                ''
            ].join('\r\n')
        );

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
                mimeTree: indexer.parseMimeTree(raw),
                meta: {}
            }
        );

        const encryptionRaw = getEncryptionOptions().raw.toString();

        expect(encryptionRaw).to.include('Delivered-To: recipient@example.com');
        expect(encryptionRaw).to.include('Return-Path: <alice@example.com>');
        expect(encryptionRaw).to.include('Subject: Encrypt reused tree');
        expect(encryptionRaw).to.include(bodyText);
    });

    it('should apply override header additions before filtering', async () => {
        const { handler, getAddOptions } = createHandler({
            filters: [
                {
                    _id: new ObjectId(),
                    query: {
                        headers: {
                            subject: 'override subject'
                        }
                    },
                    action: {
                        flag: true
                    }
                }
            ]
        });

        await handler.storeMessage(
            {
                _id: new ObjectId(),
                address: 'recipient@example.com',
                spamLevel: 50,
                encryptMessages: false,
                autoreply: false,
                tagsview: []
            },
            {
                recipient: 'recipient@example.com',
                sender: 'alice@example.com',
                raw: Buffer.from('Subject: Original\r\n\r\nHello world\r\n'),
                meta: {
                    overrides: {
                        headers: [
                            {
                                action: 'add',
                                name: 'Subject',
                                value: 'Override subject'
                            }
                        ]
                    }
                }
            }
        );

        expect(getAddOptions().flags).to.deep.equal(['\\Flagged']);
        expect(getAddOptions().prepared.mimeTree.header).to.include('Subject: Override subject');
    });

    it('should refresh derived prepared fields after override header additions', async () => {
        const { handler, getAddOptions } = createRealIndexerHandler();

        await handler.storeMessage(
            {
                _id: new ObjectId(),
                address: 'recipient@example.com',
                spamLevel: 50,
                encryptMessages: false,
                autoreply: false,
                tagsview: []
            },
            {
                recipient: 'recipient@example.com',
                sender: 'alice@example.com',
                raw: Buffer.from(
                    [
                        'From: Alice Example <alice@example.com>',
                        'To: Recipient <recipient@example.com>',
                        'Subject: Original subject',
                        'Message-ID: <original@example.com>',
                        'Date: Fri, 05 Jun 2026 12:00:00 +0000',
                        '',
                        'Hello world',
                        ''
                    ].join('\r\n')
                ),
                meta: {
                    overrides: {
                        headers: [
                            {
                                action: 'add',
                                name: 'Subject',
                                value: 'Override subject'
                            },
                            {
                                action: 'add',
                                name: 'Message-ID',
                                value: '<override@example.com>'
                            },
                            {
                                action: 'add',
                                name: 'Date',
                                value: 'Sat, 06 Jun 2026 10:20:30 +0000'
                            }
                        ]
                    }
                }
            }
        );

        const prepared = getAddOptions().prepared;

        expect(prepared.subject).to.equal('Override subject');
        expect(prepared.envelope[1].toString()).to.equal('Override subject');
        expect(prepared.msgid).to.equal('<override@example.com>');
        expect(prepared.hdate.toISOString()).to.equal('2026-06-06T10:20:30.000Z');
        expect(prepared.headers.find(header => header.key === 'message-id' && header.value === '<override@example.com>')).to.exist;
    });

    it('should add WD classification headers for non-overridden spam decisions', async () => {
        const { addOptions } = await runCase({
            spamLevel: 100
        });

        expect(addOptions.prepared.mimeTree.header).to.include('WD-Mail-Classification: not-junk');
        expect(addOptions.prepared.mimeTree.header).to.include('WD-Mail-Classification-Source: spamLevel');
        expect(addOptions.prepared.mimeTree.header).to.include('WD-Mail-Classification-Info: TBD');
    });

    it('should not add WD classification headers when spam override is applied', async () => {
        const { addOptions } = await runCase({
            overrideFlags: ['spam'],
            spamLevel: 100
        });

        expect(addOptions.prepared.mimeTree.header.some(header => /^WD-Mail-Classification:/i.test(header))).to.equal(false);
    });

    it('should pass override and classification headers into encryption input and encrypted outer headers', async () => {
        const { handler, indexer, getAddOptions, getEncryptionOptions } = createRealIndexerHandler();
        const bodyText = 'Encrypted override body.';
        const raw = Buffer.from(
            [
                'From: Alice Example <alice@example.com>',
                'To: Recipient <recipient@example.com>',
                'Subject: Encrypt override',
                'Message-ID: <encrypt-override@example.com>',
                'Date: Fri, 05 Jun 2026 12:00:00 +0000',
                '',
                bodyText,
                ''
            ].join('\r\n')
        );

        await handler.storeMessage(
            {
                _id: new ObjectId(),
                address: 'recipient@example.com',
                spamLevel: 100,
                encryptMessages: true,
                pubKey: 'test-key',
                autoreply: false,
                tagsview: []
            },
            {
                recipient: 'recipient@example.com',
                sender: 'alice@example.com',
                mimeTree: indexer.parseMimeTree(raw),
                meta: {
                    overrides: {
                        headers: [
                            {
                                action: 'add',
                                name: 'X-WD-Override',
                                value: 'yes'
                            }
                        ]
                    }
                }
            }
        );

        const encryptionRaw = getEncryptionOptions().raw.toString();
        const encryptedOuterHeaders = getAddOptions().prepared.mimeTree.header;

        expect(encryptionRaw).to.include('X-WD-Override: yes');
        expect(encryptionRaw).to.include('WD-Mail-Classification: not-junk');
        expect(encryptionRaw).to.include(bodyText);
        expect(encryptedOuterHeaders).to.include('X-WD-Override: yes');
        expect(encryptedOuterHeaders).to.include('WD-Mail-Classification: not-junk');
        expect(encryptedOuterHeaders).to.include('WD-Mail-Classification-Source: spamLevel');
    });
});
