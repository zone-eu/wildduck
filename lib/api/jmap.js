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
                outbound: true,
                preview: true
            })
            .toArray();
        return docs;
    }

    // helper: convert WildDuck message to JMAP Email format
    function messageToJmapEmail(m, properties) {
        let parsedHeader = (m.mimeTree && m.mimeTree.parsedHeader) || {};
        
        // Decode addresses from parsed headers
        let from = parsedHeader.from || parsedHeader.sender || [{ name: '', address: (m.meta && m.meta.from) || '' }];
        let to = parsedHeader.to || [];
        let cc = parsedHeader.cc || [];
        let bcc = parsedHeader.bcc || [];
        let replyTo = parsedHeader['reply-to'] || [];
        
        tools.decodeAddresses(from);
        tools.decodeAddresses(to);
        tools.decodeAddresses(cc);
        tools.decodeAddresses(bcc);
        tools.decodeAddresses(replyTo);
        
        // Map flags to JMAP keywords
        let keywords = {};
        if (m.flags && Array.isArray(m.flags)) {
            m.flags.forEach(flag => {
                if (flag === '\\Seen') keywords['$seen'] = true;
                else if (flag === '\\Flagged') keywords['$flagged'] = true;
                else if (flag === '\\Answered') keywords['$answered'] = true;
                else if (flag === '\\Draft') keywords['$draft'] = true;
                else keywords[flag] = true;
            });
        }
        if (m.unseen) keywords['$seen'] = false;
        if (m.flagged) keywords['$flagged'] = true;
        if (m.draft) keywords['$draft'] = true;
        
        // Build JMAP Email object
        let email = {
            id: m._id.toString(),
            blobId: m._id.toString(),
            threadId: m.thread || m._id.toString(),
            mailboxIds: { [m.mailbox.toString()]: true },
            keywords: keywords,
            size: m.size || 0,
            receivedAt: m.idate ? m.idate.toISOString() : new Date().toISOString()
        };
        
        // Add requested properties (default: all)
        const props = properties || ['id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 
                                      'subject', 'from', 'to', 'cc', 'bcc', 'replyTo', 'messageId', 'sentAt',
                                      'hasAttachment', 'preview', 'bodyValues', 'textBody', 'htmlBody', 'attachments'];
        
        if (!properties || props.includes('subject')) email.subject = m.subject || '';
        if (!properties || props.includes('from')) email.from = from.map(a => ({ name: a.name || '', email: a.address || '' }));
        if (!properties || props.includes('to')) email.to = to.map(a => ({ name: a.name || '', email: a.address || '' }));
        if (!properties || props.includes('cc')) email.cc = cc.map(a => ({ name: a.name || '', email: a.address || '' }));
        if (!properties || props.includes('bcc')) email.bcc = bcc.map(a => ({ name: a.name || '', email: a.address || '' }));
        if (!properties || props.includes('replyTo')) email.replyTo = replyTo.map(a => ({ name: a.name || '', email: a.address || '' }));
        if (!properties || props.includes('messageId')) email.messageId = [m.msgid || ''];
        if (!properties || props.includes('sentAt')) email.sentAt = m.hdate ? m.hdate.toISOString() : email.receivedAt;
        
        if (!properties || props.includes('hasAttachment')) {
            email.hasAttachment = !!(m.attachments && m.attachments.length > 0);
        }
        
        if (!properties || props.includes('preview')) {
            email.preview = m.preview || (m.text ? m.text.substring(0, 256) : '');
        }
        
        if (!properties || props.includes('bodyValues') || props.includes('textBody') || props.includes('htmlBody')) {
            email.bodyValues = {};
            let textPartId = '1';
            let htmlPartId = '2';
            
            if (m.text) {
                email.bodyValues[textPartId] = {
                    value: m.text,
                    isEncodingProblem: false,
                    isTruncated: false
                };
            }
            
            if (m.html && Array.isArray(m.html) && m.html.length > 0) {
                email.bodyValues[htmlPartId] = {
                    value: m.html.join(''),
                    isEncodingProblem: false,
                    isTruncated: false
                };
            } else if (typeof m.html === 'string') {
                email.bodyValues[htmlPartId] = {
                    value: m.html,
                    isEncodingProblem: false,
                    isTruncated: false
                };
            }
            
            if (!properties || props.includes('textBody')) {
                email.textBody = m.text ? [{ partId: textPartId, type: 'text/plain' }] : [];
            }
            
            if (!properties || props.includes('htmlBody')) {
                email.htmlBody = (m.html && (Array.isArray(m.html) ? m.html.length : m.html)) ? [{ partId: htmlPartId, type: 'text/html' }] : [];
            }
        }
        
        if (!properties || props.includes('attachments')) {
            email.attachments = (m.attachments || []).map(att => ({
                partId: att.id || att._id || att.contentId || String(Math.random()),
                blobId: att.id || att._id || '',
                type: att.contentType || 'application/octet-stream',
                name: att.filename || 'attachment',
                size: att.size || 0,
                cid: att.cid || null
            }));
        }
        
        return email;
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
                const username = idx >= 0 ? creds.substring(0, idx) : creds;
                const password = idx >= 0 ? creds.substring(idx + 1) : '';
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
                state = String(Math.max(mboxIndex, msgMod, 1));
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
                    const username = idx >= 0 ? creds.substring(0, idx) : creds;
                    const password = idx >= 0 ? creds.substring(idx + 1) : '';
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
            return String(Math.max(mboxIndex, msgMod, 1));
        } catch (err) {
            return String(1);
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
                const username = idx >= 0 ? creds.substring(0, idx) : creds;
                const password = idx >= 0 ? creds.substring(idx + 1) : '';
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
                        // Fetch mailboxes with proper JMAP format
                        const mailboxes = await db.database.collection('mailboxes')
                            .find({ user: new ObjectId(userId) })
                            .toArray();
                            
                        const list = mailboxes.map(m => {
                            let role = null;
                            if (m.specialUse) {
                                const useMap = {
                                    '\\Inbox': 'inbox',
                                    '\\Sent': 'sent',
                                    '\\Drafts': 'drafts',
                                    '\\Trash': 'trash',
                                    '\\Junk': 'junk',
                                    '\\Archive': 'archive'
                                };
                                role = useMap[m.specialUse] || null;
                            }
                            
                            return {
                                id: m._id.toString(),
                                name: m.path.split('/').pop(),
                                parentId: m.parent ? m.parent.toString() : null,
                                role: role,
                                sortOrder: m.path === 'INBOX' ? 0 : 10,
                                totalEmails: 0,
                                unreadEmails: 0,
                                totalThreads: 0,
                                unreadThreads: 0,
                                myRights: {
                                    mayReadItems: true,
                                    mayAddItems: true,
                                    mayRemoveItems: true,
                                    maySetSeen: true,
                                    maySetKeywords: true,
                                    mayCreateChild: true,
                                    mayRename: m.path !== 'INBOX',
                                    mayDelete: m.path !== 'INBOX',
                                    maySubmit: true
                                },
                                isSubscribed: !!m.subscribed
                            };
                        });
                        
                        // Fetch counts in parallel for performance
                        await Promise.all(list.map(async (mb) => {
                            try {
                                const counts = await db.database.collection('messages').aggregate([
                                    { $match: { mailbox: new ObjectId(mb.id), user: new ObjectId(userId), undeleted: true } },
                                    { $group: { 
                                        _id: null, 
                                        total: { $sum: 1 },
                                        unread: { $sum: { $cond: ['$unseen', 1, 0] } }
                                    }}
                                ]).toArray();
                                
                                if (counts && counts[0]) {
                                    mb.totalEmails = counts[0].total || 0;
                                    mb.unreadEmails = counts[0].unread || 0;
                                    mb.totalThreads = counts[0].total || 0; // simplified
                                    mb.unreadThreads = counts[0].unread || 0;
                                }
                            } catch (e) {
                                // ignore count errors
                            }
                        }));
                        
                        responses.push(['Mailbox/get', { 
                            accountId: userId,
                            state: await getCurrentState(), 
                            list, 
                            notFound: [] 
                        }, callId]);
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
                        // support basic filter: inMailbox: '<mailboxId>', hasKeyword, notKeyword
                        let filter = { user: new ObjectId(userId), undeleted: true };
                        
                        if (args.filter && typeof args.filter === 'object') {
                            if (args.filter.inMailbox && ObjectId.isValid(args.filter.inMailbox)) {
                                try {
                                    filter.mailbox = new ObjectId(args.filter.inMailbox);
                                } catch (E) {
                                    // ignore bad id
                                }
                            }
                            
                            // Support keyword filters
                            if (args.filter.hasKeyword) {
                                const kw = args.filter.hasKeyword;
                                if (kw === '$seen' || kw === '\\Seen') filter.unseen = false;
                                else if (kw === '$flagged' || kw === '\\Flagged') filter.flagged = true;
                                else if (kw === '$draft' || kw === '\\Draft') filter.draft = true;
                                else if (kw === '$answered' || kw === '\\Answered') filter.flags = kw.startsWith('$') ? '\\' + kw.substring(1).charAt(0).toUpperCase() + kw.substring(2) : kw;
                                else filter.flags = kw;
                            }
                            
                            if (args.filter.notKeyword) {
                                const kw = args.filter.notKeyword;
                                if (kw === '$seen' || kw === '\\Seen') filter.unseen = true;
                                else if (kw === '$flagged' || kw === '\\Flagged') filter.flagged = false;
                                else if (kw === '$draft' || kw === '\\Draft') filter.draft = false;
                            }
                            
                            // Support text search
                            if (args.filter.text) {
                                filter.$or = [
                                    { subject: { $regex: args.filter.text, $options: 'i' } },
                                    { text: { $regex: args.filter.text, $options: 'i' } }
                                ];
                            }
                            
                            if (args.filter.subject) {
                                filter.subject = { $regex: args.filter.subject, $options: 'i' };
                            }
                        }

                        let limit = Math.min(args.limit || 50, 1000);
                        let position = args.position || 0;
                        
                        // Support sorting (default: newest first)
                        let sort = { idate: -1 };
                        if (args.sort && Array.isArray(args.sort) && args.sort.length > 0) {
                            const sortField = args.sort[0];
                            if (sortField.property === 'receivedAt') {
                                sort = { idate: sortField.isAscending ? 1 : -1 };
                            } else if (sortField.property === 'sentAt') {
                                sort = { hdate: sortField.isAscending ? 1 : -1 };
                            } else if (sortField.property === 'subject') {
                                sort = { subject: sortField.isAscending ? 1 : -1 };
                            } else if (sortField.property === 'size') {
                                sort = { size: sortField.isAscending ? 1 : -1 };
                            }
                        }
                        
                        let cursor = db.database.collection('messages')
                            .find(filter)
                            .sort(sort)
                            .skip(position)
                            .limit(limit);
                            
                        const list = await cursor.toArray();
                        const ids = list.map(m => m._id.toString());
                        const total = await db.database.collection('messages').countDocuments(filter);
                        
                        responses.push(['Email/query', { 
                            accountId: userId,
                            queryState: await getCurrentState(),
                            canCalculateChanges: true, 
                            position: position, 
                            ids, 
                            total,
                            limit
                        }, callId]);
                        continue;
                    }

                    if (methodName === 'Email/get') {
                        // ids param expected as array
                        let ids = args.ids || [];
                        let properties = args.properties || null;
                        
                        const messages = await fetchMessagesByIds(ids, userId);
                        const list = messages.map(m => messageToJmapEmail(m, properties));
                        
                        // Find which IDs were not found
                        const foundIds = new Set(messages.map(m => m._id.toString()));
                        const notFound = ids.filter(id => !foundIds.has(id));
                        
                        responses.push(['Email/get', { 
                            accountId: userId,
                            state: await getCurrentState(), 
                            list, 
                            notFound 
                        }, callId]);
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

                        const changedDocs = await db.database.collection('messages').find({ user: new ObjectId(userId), modseq: { $gt: sinceNum } }).project({ _id: true, undeleted: true, idate: true }).toArray();

                        const created = [];
                        const updated = [];
                        const destroyed = [];

                        // Categorize changes based on idate relative to sinceNum
                        const sinceDate = new Date(sinceNum);
                        for (const d of changedDocs) {
                            const idStr = d._id.toString();
                            if (d.undeleted === false) {
                                destroyed.push(idStr);
                            } else {
                                // If message was created after sinceState, it's new; otherwise it's updated
                                if (d.idate && d.idate > sinceDate) {
                                    created.push(idStr);
                                } else {
                                    updated.push(idStr);
                                }
                            }
                        }

                        responses.push(['Email/changes', { accountId: userId, oldState: String(sinceNum), newState: String(curState), hasMoreChanges: false, created, updated, destroyed }, callId]);
                        continue;
                    }

                    if (methodName === 'Email/set') {
                        // args: { create, update, destroy }
                        let created = {};
                        let updated = {};
                        let destroyed = [];
                        let notCreated = {};
                        let notUpdated = {};
                        let notDestroyed = {};

                        // Handle update operations
                        if (args.update) {
                            for (let id of Object.keys(args.update)) {
                                const patch = args.update[id];
                                let messageId = id;
                                if (!ObjectId.isValid(messageId)) {
                                    notUpdated[id] = { type: 'invalidProperties', description: 'Invalid message ID' };
                                    continue;
                                }
                                const oid = new ObjectId(messageId);
                                let msg = await db.database.collection('messages').findOne({ _id: oid, user: new ObjectId(userId) });
                                if (!msg) {
                                    notUpdated[id] = { type: 'notFound' };
                                    continue;
                                }

                                try {
                                    let updateOps = {};
                                    
                                    // Handle keywords update (supports JMAP keyword format)
                                    if (patch.keywords !== undefined) {
                                        let flags = [];
                                        let updateFields = {};
                                        
                                        for (let kw of Object.keys(patch.keywords)) {
                                            if (!patch.keywords[kw]) continue; // skip false keywords
                                            
                                            if (kw === '$seen' || kw === '\\Seen') {
                                                updateFields.unseen = false;
                                            } else if (kw === '$flagged' || kw === '\\Flagged') {
                                                updateFields.flagged = true;
                                                flags.push('\\Flagged');
                                            } else if (kw === '$answered' || kw === '\\Answered') {
                                                flags.push('\\Answered');
                                            } else if (kw === '$draft' || kw === '\\Draft') {
                                                updateFields.draft = true;
                                                flags.push('\\Draft');
                                            } else {
                                                flags.push(kw);
                                            }
                                        }
                                        
                                        // Check for removed keywords
                                        if (patch.keywords['$seen'] === false) {
                                            updateFields.unseen = true;
                                        }
                                        if (patch.keywords['$flagged'] === false) {
                                            updateFields.flagged = false;
                                        }
                                        
                                        updateOps.$set = { ...updateOps.$set, ...updateFields, flags };
                                    }
                                    
                                    // Handle mailboxIds change (move message)
                                    if (patch.mailboxIds && typeof patch.mailboxIds === 'object') {
                                        const newMailboxIds = Object.keys(patch.mailboxIds).filter(k => patch.mailboxIds[k]);
                                        if (newMailboxIds.length > 0 && ObjectId.isValid(newMailboxIds[0])) {
                                            const targetMailbox = new ObjectId(newMailboxIds[0]);
                                            // Verify mailbox exists and belongs to user
                                            const mbExists = await db.database.collection('mailboxes')
                                                .findOne({ _id: targetMailbox, user: new ObjectId(userId) });
                                            if (mbExists) {
                                                updateOps.$set = { ...updateOps.$set, mailbox: targetMailbox };
                                            }
                                        }
                                    }
                                    
                                    // Legacy support for direct flag operations
                                    if (patch.setFlags) {
                                        updateOps.$set = { ...updateOps.$set, flags: patch.setFlags };
                                    } else if (patch.addFlags) {
                                        updateOps.$addToSet = { flags: { $each: patch.addFlags } };
                                    } else if (patch.removeFlags) {
                                        updateOps.$pull = { flags: { $in: patch.removeFlags } };
                                    }
                                    
                                    if (Object.keys(updateOps).length > 0) {
                                        await db.database.collection('messages').updateOne(
                                            { _id: oid, user: new ObjectId(userId) },
                                            updateOps
                                        );
                                        
                                        // Track change in changelog
                                        try {
                                            if (messageHandler && messageHandler.jmapChanges) {
                                                await messageHandler.jmapChanges.appendChange(userId, { type: 'updated', id: id });
                                            }
                                        } catch (E) {
                                            // ignore changelog errors
                                        }
                                        
                                        // Send notifier updates
                                        try {
                                            const mailboxData = await messageHandler.getMailboxAsync({ mailbox: msg.mailbox });
                                            const notify = [{
                                                command: 'FETCH',
                                                uid: msg.uid,
                                                flags: updateOps.$set?.flags || msg.flags || [],
                                                message: msg._id,
                                                thread: msg.thread,
                                                unseenChange: updateOps.$set?.unseen !== undefined
                                            }];
                                            await new Promise(r => messageHandler.notifier.addEntries(mailboxData, notify, r));
                                            messageHandler.notifier.fire(msg.user);
                                        } catch (N) {
                                            // ignore notifier errors
                                        }
                                        
                                        updated[id] = null; // JMAP spec: null means success with no additional data
                                    }
                                } catch (err) {
                                    notUpdated[id] = { type: err.code || 'serverFail', description: err.message };
                                }
                            }
                        }
                        
                        // Handle destroy operations
                        if (args.destroy && Array.isArray(args.destroy)) {
                            for (let id of args.destroy) {
                                if (!ObjectId.isValid(id)) {
                                    notDestroyed[id] = { type: 'invalidProperties', description: 'Invalid message ID' };
                                    continue;
                                }
                                
                                try {
                                    const oid = new ObjectId(id);
                                    const msg = await db.database.collection('messages').findOne({ _id: oid, user: new ObjectId(userId) });
                                    
                                    if (!msg) {
                                        notDestroyed[id] = { type: 'notFound' };
                                        continue;
                                    }
                                    
                                    // Set undeleted flag to false (soft delete)
                                    await db.database.collection('messages').updateOne(
                                        { _id: oid },
                                        { $set: { undeleted: false, modseq: await getCurrentState() } }
                                    );
                                    
                                    // Track destruction in changelog
                                    try {
                                        if (messageHandler && messageHandler.jmapChanges) {
                                            await messageHandler.jmapChanges.appendChange(userId, { type: 'destroyed', id: id });
                                        }
                                    } catch (E) {
                                        // ignore changelog errors
                                    }
                                    
                                    destroyed.push(id);
                                } catch (err) {
                                    notDestroyed[id] = { type: err.code || 'serverFail', description: err.message };
                                }
                            }
                        }

                        const newState = await getCurrentState();
                        responses.push(['Email/set', { 
                            accountId: userId, 
                            oldState: args.ifInState || newState, 
                            newState: newState, 
                            created, 
                            updated, 
                            destroyed,
                            notCreated,
                            notUpdated,
                            notDestroyed
                        }, callId]);
                        continue;
                    }

                    if (methodName === 'Email/send') {
                        // Accept args.create: { clientId: { email: { to, cc, bcc, subject, text, html, attachments } } }
                        const sent = {};
                        const notCreated = {};
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
                                    notCreated[cid] = {
                                        type: err.code || 'serverFail',
                                        description: err.message
                                    };
                                }
                            }
                        }
                        responses.push(['Email/send', { accountId: userId, notCreated, created: sent }, callId]);
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
