'use strict';

const config = require('@zone-eu/wild-config');
const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const roles = require('../roles');

module.exports = (db, server, messageHandler, mailboxHandler, userHandler, storageHandler, notifier, settingsHandler) => {
    const basePath = (config.jmap && config.jmap.basePath) || '/jmap';

    // Well-known discovery
    server.get(
        { name: 'jmap-well-known', path: '/.well-known/jmap', excludeRoute: true },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const apiUrl = (req.headers.host ? (req.headers['x-forwarded-proto'] || (config.api && config.api.secure ? 'https' : 'http')) + '://' + req.headers.host : '') + basePath;

            return res.json({
                success: true,
                apiUrl: apiUrl,
                capabilities: {
                    'urn:ietf:params:jmap:core': {},
                    'urn:ietf:params:jmap:mail': {}
                }
            });
        })
    );

    // helper: fetch message by _id
    async function fetchMessagesByIds(ids, userId) {
        let oids = ids.map(id => (ObjectId.isValid(id) ? new ObjectId(id) : null)).filter(Boolean);
        if (!oids.length) return [];
        const docs = await db.database
            .collection('messages')
            .find({ _id: { $in: oids }, user: new ObjectId(userId) })
            .project({
                _id: true,
                mailbox: true,
                uid: true,
                thread: true,
                'mimeTree.parsedHeader': true,
                subject: true,
                msgid: true,
                hdate: true,
                idate: true,
                size: true,
                unseen: true,
                undeleted: true,
                flagged: true,
                draft: true,
                flags: true,
                attachments: true,
                html: true,
                text: true,
                forwardTargets: true,
                meta: true,
                verificationResults: true,
                outbound: true
            })
            .toArray();
        return docs;
    }

    // JMAP session resource
    server.get(
        {
            name: 'jmap-session',
            path: basePath,
            validationObjs: {
                requestBody: {}
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            // authenticate (allow token or Basic)
            let userId = null;
            if (req.user && /^[0-9a-f]{24}$/i.test(req.user)) {
                userId = req.user;
            } else if (req.headers && req.headers.authorization && /^Basic\s+/i.test(req.headers.authorization)) {
                const creds = Buffer.from(req.headers.authorization.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
                const idx = creds.indexOf(':');
                const username = idx >= 0 ? creds.substr(0, idx) : creds;
                const password = idx >= 0 ? creds.substr(idx + 1) : '';
                try {
                    const [authData] = await userHandler.asyncAuthenticate(username, password, 'master', { ip: req.params && req.params.ip });
                    if (!authData) {
                        res.status(403);
                        return res.json({ error: 'Authentication failed', code: 'AuthFailed' });
                    }
                    userId = authData.user.toString();
                    req.user = userId;
                } catch (err) {
                    res.status(403);
                    return res.json({ error: err.message, code: err.code || 'AuthFailed' });
                }
            } else {
                res.status(401);
                return res.json({ error: 'Auth required', code: 'AuthRequired' });
            }

            // compute a simple state token
            let state = '0';
            try {
                const mbox = await db.database.collection('mailboxes').find().sort({ modifyIndex: -1 }).limit(1).toArray();
                const mm = await db.database.collection('messages').find().sort({ modseq: -1 }).limit(1).toArray();
                let mboxIndex = mbox && mbox[0] && mbox[0].modifyIndex ? Number(mbox[0].modifyIndex) : 0;
                let msgMod = mm && mm[0] && mm[0].modseq ? Number(mm[0].modseq) : 0;
                state = String(Math.max(mboxIndex, msgMod, Date.now()));
            } catch (E) {
                // ignore
            }

            const apiUrl = (req.headers.host ? (req.headers['x-forwarded-proto'] || (config.api && config.api.secure ? 'https' : 'http')) + '://' + req.headers.host : '') + basePath;
            const uploadUrl = (req.headers.host ? (req.headers['x-forwarded-proto'] || (config.api && config.api.secure ? 'https' : 'http')) + '://' + req.headers.host : '') + basePath + '/upload';
            const eventSourceUrl = (req.headers.host ? (req.headers['x-forwarded-proto'] || (config.api && config.api.secure ? 'https' : 'http')) + '://' + req.headers.host : '') + '/users/:user/updates';
            const downloadUrlTemplate = (req.headers.host ? (req.headers['x-forwarded-proto'] || (config.api && config.api.secure ? 'https' : 'http')) + '://' + req.headers.host : '') + '/users/:user/storage/:file';

            const accountId = userId;

            return res.json({
                username: userId,
                accounts: { [accountId]: { name: userId, isPrimary: true, accountCapabilities: {} } },
                primaryAccounts: { 'urn:ietf:params:jmap:mail': accountId },
                capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
                apiUrl: apiUrl,
                downloadUrl: downloadUrlTemplate,
                uploadUrl: uploadUrl,
                eventSourceUrl: eventSourceUrl,
                state: state,
                maxUploadSize: (config.jmap && config.jmap.maxUploadMB ? Number(config.jmap.maxUploadMB) * 1024 * 1024 : 25 * 1024 * 1024)
            });
        })
    );

    // upload endpoint for JMAP blobs
    server.post(
        {
            name: 'jmap-upload',
            path: basePath + '/upload',
            validationObjs: {
                requestBody: {}
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            // authenticate
            if (!req.user || !/^[0-9a-f]{24}$/i.test(req.user)) {
                if (req.headers && req.headers.authorization && /^Basic\s+/i.test(req.headers.authorization)) {
                    const creds = Buffer.from(req.headers.authorization.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
                    const idx = creds.indexOf(':');
                    const username = idx >= 0 ? creds.substr(0, idx) : creds;
                    const password = idx >= 0 ? creds.substr(idx + 1) : '';
                    try {
                        const [authData] = await userHandler.asyncAuthenticate(username, password, 'master', { ip: req.params && req.params.ip });
                        if (!authData) {
                            res.status(403);
                            return res.json({ error: 'Authentication failed', code: 'AuthFailed' });
                        }
                        req.user = authData.user.toString();
                    } catch (err) {
                        res.status(403);
                        return res.json({ error: err.message, code: err.code || 'AuthFailed' });
                    }
                } else {
                    res.status(401);
                    return res.json({ error: 'Auth required', code: 'AuthRequired' });
                }
            }

            let user = new ObjectId(req.user);

            let filename = req.headers['x-filename'] || req.params.filename || (req.body && req.body.filename);
            let contentType = req.headers['content-type'] || req.params.contentType || (req.body && req.body.contentType);
            let cid = req.headers['x-cid'] || req.params.cid || (req.body && req.body.cid);

            let content;
            let encoding;

            if (req.body && (Buffer.isBuffer(req.body) || typeof req.body === 'string')) {
                content = req.body;
            } else if (req.params && req.params.content) {
                content = req.params.content;
                encoding = req.params.encoding;
            } else if (req.body && req.body.content && typeof req.body.content === 'string') {
                content = req.body.content;
                encoding = req.body.encoding || 'base64';
            } else {
                res.status(400);
                return res.json({ error: 'Missing content', code: 'InputValidationError' });
            }

            // enforce max upload size from config
            try {
                const maxBytes = (config.jmap && config.jmap.maxUploadMB ? Number(config.jmap.maxUploadMB) * 1024 * 1024 : 25 * 1024 * 1024);
                let sizeBytes = 0;
                if (Buffer.isBuffer(content)) {
                    sizeBytes = content.length;
                } else if (typeof content === 'string') {
                    if (encoding === 'base64') {
                        // approximate: base64 length -> bytes
                        sizeBytes = Math.floor((content.length * 3) / 4);
                    } else {
                        sizeBytes = Buffer.byteLength(content);
                    }
                }

                if (sizeBytes > maxBytes) {
                    res.status(413);
                    return res.json({ error: 'File too large', code: 'PayloadTooLarge' });
                }
            } catch (E) {
                // ignore size check error and proceed
            }

            try {
                const id = await storageHandler.add(user, { filename, contentType, content, cid, encoding });
                return res.json({ success: true, id: id.toString() });
            } catch (err) {
                res.status(500);
                return res.json({ error: err.message, code: err.code || 'InternalStorageError' });
            }
        })
    );

    // helper: get current global state number
    async function getCurrentState() {
        try {
            const mbox = await db.database.collection('mailboxes').find().sort({ modifyIndex: -1 }).limit(1).toArray();
            const mm = await db.database.collection('messages').find().sort({ modseq: -1 }).limit(1).toArray();
            let mboxIndex = mbox && mbox[0] && mbox[0].modifyIndex ? Number(mbox[0].modifyIndex) : 0;
            let msgMod = mm && mm[0] && mm[0].modseq ? Number(mm[0].modseq) : 0;
            return String(Math.max(mboxIndex, msgMod, Date.now()));
        } catch (err) {
            return String(Date.now());
        }
    }

    // JMAP dispatcher: implement Mailbox and Email methods
    server.post(
        {
            name: 'jmap',
            path: basePath,
            validationObjs: {
                requestBody: {
                    methodCalls: Joi.array().required()
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const body = req.body || req.params || {};
            const methodCalls = body.methodCalls || [];

            // authenticate: token-based auth (middleware) or Basic fallback
            let userId = null;
            if (req.user && /^[0-9a-f]{24}$/i.test(req.user)) {
                userId = req.user;
            } else if (req.headers && req.headers.authorization && /^Basic\s+/i.test(req.headers.authorization)) {
                const creds = Buffer.from(req.headers.authorization.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
                const idx = creds.indexOf(':');
                const username = idx >= 0 ? creds.substr(0, idx) : creds;
                const password = idx >= 0 ? creds.substr(idx + 1) : '';
                try {
                    const [authData] = await userHandler.asyncAuthenticate(username, password, 'master', { ip: req.params && req.params.ip });
                    if (!authData) {
                        res.status(403);
                        return res.json({ error: 'Authentication failed', code: 'AuthFailed' });
                    }
                    userId = authData.user.toString();
                    req.user = userId;
                } catch (err) {
                    res.status(403);
                    return res.json({ error: err.message, code: err.code || 'AuthFailed' });
                }
            } else {
                res.status(401);
                return res.json({ error: 'Auth required', code: 'AuthRequired' });
            }

            const responses = [];

            for (let i = 0; i < methodCalls.length; i++) {
                const call = methodCalls[i];
                const methodName = Array.isArray(call) ? call[0] : null;
                const args = Array.isArray(call) ? call[1] : {};
                const callId = Array.isArray(call) ? call[2] : `R${i}`;

                try {
                    if (methodName === 'Mailbox/get') {
                        // reuse mailboxes listing
                        const mailboxes = await db.database.collection('mailboxes').find({ user: new ObjectId(userId) }).toArray();
                        const list = mailboxes.map(m => ({ id: m._id.toString(), name: m.path.split('/').pop(), path: m.path, specialUse: m.specialUse || false, subscribed: !!m.subscribed }));
                        responses.push(['Mailbox/get', { list, state: '0', notFound: [] }, callId]);
                        continue;
                    }

                    if (methodName === 'Mailbox/set') {
                        // args may contain create, update, destroy
                        let created = {};
                        if (args.create) {
                            for (let clientId of Object.keys(args.create)) {
                                let data = args.create[clientId];
                                try {
                                    const r = await mailboxHandler.createAsync(new ObjectId(userId), data.path, data);
                                    created[clientId] = { id: r.id.toString() };
                                } catch (err) {
                                    // notCreated
                                }
                            }
                        }
                        responses.push(['Mailbox/set', { created, notCreated: {}, destroyed: [], updated: {} }, callId]);
                        continue;
                    }

                    if (methodName === 'Email/query') {
                        // support basic filter: inMailbox: '<mailboxId>'
                        let filter = { user: new ObjectId(userId) };
                        if (args.filter && args.filter.inMailbox) {
                            try {
                                filter.mailbox = new ObjectId(args.filter.inMailbox);
                            } catch (E) {
                                // ignore bad id
                            }
                        }

                        let limit = args.limit || 20;
                        let cursor = db.database.collection('messages').find(filter).sort({ idate: -1 }).limit(limit);
                        const list = await cursor.toArray();
                        const ids = list.map(m => m._id.toString());
                        const total = await db.database.collection('messages').countDocuments(filter);
                        responses.push(['Email/query', { ids, total, canCalculateChanges: true, position: 0 }, callId]);
                        continue;
                    }

                    if (methodName === 'Email/get') {
                        // ids param expected as array
                        let ids = args.ids || [];
                        const messages = await fetchMessagesByIds(ids, userId);
                        const list = messages.map(m => {
                            let parsedHeader = (m.mimeTree && m.mimeTree.parsedHeader) || {};
                            let from = parsedHeader.from || parsedHeader.sender || [{ name: '', address: (m.meta && m.meta.from) || '' }];
                            tools.decodeAddresses(from);
                            return {
                                id: m._id.toString(),
                                mailboxId: m.mailbox ? m.mailbox.toString() : null,
                                threadId: m.thread,
                                subject: m.subject || '',
                                date: m.hdate ? m.hdate.toISOString() : null,
                                size: m.size || 0,
                                text: m.text || '',
                                html: m.html || [],
                                from: from[0],
                                to: [],
                                cc: [],
                                bcc: [],
                                keywords: m.flags || []
                            };
                        });
                        responses.push(['Email/get', { list, notFound: [] }, callId]);
                        continue;
                    }

                    if (methodName === 'Email/changes') {
                        // args: sinceState, maxChanges
                        const since = args.sinceState ? String(args.sinceState) : null;

                        // prefer deterministic changelog if available
                        try {
                            if (messageHandler && messageHandler.jmapChanges) {
                                const res = await messageHandler.jmapChanges.getChangesSince(userId, since);
                                responses.push(['Email/changes', { accountId: userId, oldState: String(since || '0'), newState: res.newState, hasMoreChanges: false, created: res.created, updated: res.updated, destroyed: res.destroyed }, callId]);
                                continue;
                            }
                        } catch (E) {
                            // fall back to best-effort below
                        }

                        // fallback (best-effort): use modseq / modifyIndex
                        const sinceNum = args.sinceState ? Number(args.sinceState) : 0;
                        const curState = Number(await getCurrentState());

                        if (sinceNum >= curState) {
                            responses.push(['Email/changes', { accountId: userId, oldState: String(sinceNum), newState: String(curState), hasMoreChanges: false, created: [], updated: [], destroyed: [] }, callId]);
                            continue;
                        }

                        const changedDocs = await db.database.collection('messages').find({ user: new ObjectId(userId), modseq: { $gt: sinceNum } }).project({ _id: true, undeleted: true }).toArray();

                        const created = [];
                        const updated = [];
                        const destroyed = [];

                        for (const d of changedDocs) {
                            const idStr = d._id.toString();
                            if (d.undeleted === false) {
                                destroyed.push(idStr);
                            } else {
                                created.push(idStr);
                            }
                        }

                        responses.push(['Email/changes', { accountId: userId, oldState: String(sinceNum), newState: String(curState), hasMoreChanges: false, created, updated, destroyed }, callId]);
                        continue;
                    }

                    if (methodName === 'Email/set') {
                        // args: { update: { id: { setFlags: ['\\Seen'] } } }
                        let updated = [];
                        let notUpdated = {};

                        if (args.update) {
                            for (let id of Object.keys(args.update)) {
                                const op = args.update[id];
                                let messageId = id;
                                if (!ObjectId.isValid(messageId)) {
                                    notUpdated[id] = { type: 'invalidId' };
                                    continue;
                                }
                                const oid = new ObjectId(messageId);
                                let msg = await db.database.collection('messages').findOne({ _id: oid, user: new ObjectId(userId) });
                                if (!msg) {
                                    notUpdated[id] = { type: 'notFound' };
                                    continue;
                                }

                                // For simplicity, support setFlags, addFlags, removeFlags
                                try {
                                    if (op.setFlags) {
                                        await db.database.collection('messages').updateOne({ _id: oid }, { $set: { flags: op.setFlags } });
                                    } else if (op.addFlags) {
                                        await db.database.collection('messages').updateOne({ _id: oid }, { $addToSet: { flags: { $each: op.addFlags } } });
                                    } else if (op.removeFlags) {
                                        await db.database.collection('messages').updateOne({ _id: oid }, { $pull: { flags: { $in: op.removeFlags } } });
                                    } else {
                                        notUpdated[id] = { type: 'badRequest' };
                                        continue;
                                    }

                                    // if message became deleted add destroyed changelog entry
                                    try {
                                        const isDeleted = (op.addFlags && op.addFlags.includes('\\Deleted')) || (op.setFlags && op.setFlags.includes('\\Deleted'));
                                        if (isDeleted && messageHandler && messageHandler.jmapChanges) {
                                            await messageHandler.jmapChanges.appendChange(userId, { type: 'destroyed', id: id });
                                        } else if (messageHandler && messageHandler.jmapChanges) {
                                            // flag update -> updated
                                            await messageHandler.jmapChanges.appendChange(userId, { type: 'updated', id: id });
                                        }
                                    } catch (E) {
                                        // ignore changelog errors
                                    }

                                    // send notifier updates for mailbox
                                    try {
                                        const mailboxData = await messageHandler.getMailboxAsync({ mailbox: msg.mailbox });
                                        const notify = [
                                            {
                                                command: 'FETCH',
                                                uid: msg.uid,
                                                flags: (op.setFlags || msg.flags || []).concat(op.addFlags || []).filter(Boolean),
                                                message: msg._id,
                                                thread: msg.thread,
                                                unseenChange: false
                                            }
                                        ];
                                        await new Promise(r => messageHandler.notifier.addEntries(mailboxData, notify, r));
                                        messageHandler.notifier.fire(msg.user);
                                    } catch (N) {
                                        // ignore notifier errors
                                    }

                                    updated.push(id);
                                } catch (err) {
                                    notUpdated[id] = { type: err.code || 'InternalDatabaseError' };
                                }
                            }
                        }

                        responses.push(['Email/set', { accountId: userId, oldState: '0', newState: '0', created: {}, updated, notUpdated }, callId]);
                        continue;
                    }

                    if (methodName === 'Email/send') {
                        // Accept args.create: { clientId: { email: { to, cc, bcc, subject, text, html, attachments } } }
                        const sent = {};
                        if (args.create) {
                            for (let cid of Object.keys(args.create)) {
                                const data = args.create[cid].email || args.create[cid];
                                // map to submit API: user and fields
                                try {
                                    // map attachments: if blobId provided, fetch from storage
                                    let attachments = [];
                                    if (Array.isArray(data.attachments)) {
                                        for (let a of data.attachments) {
                                            if (a && a.blobId) {
                                                try {
                                                    const file = await storageHandler.get(new ObjectId(userId), new ObjectId(a.blobId));
                                                    attachments.push({ filename: a.filename || file.filename, contentType: a.contentType || file.contentType, encoding: 'base64', content: file.content.toString('base64'), cid: file.cid || undefined });
                                                } catch (E) {
                                                    // skip missing blob
                                                }
                                            } else if (a) {
                                                attachments.push(a);
                                            }
                                        }
                                    }

                                    const submitArgs = {
                                        user: new ObjectId(userId),
                                        to: (data.to || []).map(a => (typeof a === 'string' ? { address: a } : a)),
                                        cc: data.cc || [],
                                        bcc: data.bcc || [],
                                        subject: data.subject || '',
                                        text: data.text || data.plainText || '',
                                        html: data.html || '',
                                        attachments: attachments,
                                        isDraft: false
                                    };
                                    const info = await server.submitMessage(submitArgs);
                                    sent[cid] = { id: info.id, mailboxId: info.mailbox }; // preserve returned info

                                    // append changelog created entry if available
                                    try {
                                        if (messageHandler && messageHandler.jmapChanges && info && info.id) {
                                            await messageHandler.jmapChanges.appendChange(userId, { type: 'created', id: String(info.id) });
                                        }
                                    } catch (E) {
                                        // ignore changelog errors
                                    }
                                } catch (err) {
                                    // on failure leave empty and report notCreated
                                }
                            }
                        }
                        responses.push(['Email/send', { accountId: userId, notCreated: {}, created: sent }, callId]);
                        continue;
                    }

                    // unknown method
                    responses.push(['error', { type: 'unknownMethod', description: 'Method not implemented' }, callId]);
                } catch (err) {
                    responses.push(['error', { type: err.code || 'exception', description: err.message }, callId]);
                }
            }

            return res.json({ methodResponses: responses, sessionState: await getCurrentState() });
        })
    );
};
