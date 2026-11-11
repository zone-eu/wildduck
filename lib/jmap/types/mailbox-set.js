'use strict';

// Mailbox/set (RFC 8621 2.5). Every write goes through MailboxHandler, like the REST API and IMAP, so
// the change is journaled, pushed and visible to IMAP sessions right away.
//
// A mailbox is a path; name and parentId are derived from it (see mailbox.js). The call works on one
// in memory copy of the account's mailboxes, updated after every write, so that each object is judged
// against the tree the previous objects left behind without reading the mailboxes again.
//
// The server orders dependent operations of one call: a create whose parentId names another creation id
// of the call creates that one first, a destroy of a parent whose children are all destroyed in the same
// call destroys the children first, and a create whose name is taken by a mailbox destroyed in the same
// call destroys that mailbox first. Cycles and failed dependencies fail the dependent object.

const { isDeepStrictEqual } = require('util');
const { URN } = require('../capabilities');
const { formatId, parseId } = require('../ids');
const { invalidArguments } = require('../errors');
const { SetError, invalidProperties } = require('../set-errors');
const { applyPatch } = require('../patch');
const { runSet, resolveId, referencedIds } = require('../set');
const { mailState } = require('../state');
const { mailboxCounts } = require('../mailbox-counts');
const { loadMailboxes, invalidateMailCache, roleOf, rightsOf, MAX_DEPTH, MAX_NAME } = require('./mailbox');
const { isObject, setOwn } = require('./common');
const consts = require('../../consts');

const PROPERTIES = ['id', 'name', 'parentId', 'role', 'sortOrder', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads', 'myRights', 'isSubscribed'];
const COUNTS = ['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'];
const SERVER_SET = ['id', ...COUNTS, 'myRights'];
const MAX_SORT_ORDER = 2 ** 31 - 1;
// the characters sanitizeMailbox() would silently remove from a path
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/; // eslint-disable-line no-control-regex

const depthOf = path => path.split('/').length;

/**
 * Checks a mailbox name and answers it in NFC (RFC 8621 2: Net-Unicode). Names may not be blank, hold
 * control characters or the hierarchy delimiter, or exceed maxSizeMailboxName UTF-8 octets.
 *
 * @returns {String} the normalised name
 * @throws {SetError} invalidProperties on name
 */
function checkName(name) {
    if (typeof name !== 'string') {
        throw invalidProperties('name', 'name must be a string');
    }
    const normalised = name.normalize('NFC');
    if (!normalised.trim()) {
        throw invalidProperties('name', 'name can not be empty');
    }
    if (CONTROL.test(normalised) || normalised.includes('/')) {
        throw invalidProperties('name', 'name can not contain control characters or "/"');
    }
    if (Buffer.byteLength(normalised) > MAX_NAME) {
        throw invalidProperties('name', `name can not be longer than ${MAX_NAME} octets`);
    }
    return normalised;
}

const validSortOrder = value => Number.isInteger(value) && value >= 0 && value <= MAX_SORT_ORDER;

/**
 * The account's mailboxes as one mutable tree for the duration of a call. Hidden mailboxes are part of
 * the tree (they occupy paths and move with their ancestors) but can not be addressed.
 */
class MailboxTree {
    constructor(docs) {
        this.byId = new Map();
        this.byPath = new Map();
        for (const doc of docs) {
            this.add({
                _id: doc._id,
                user: doc.user,
                path: doc.path,
                specialUse: doc.specialUse,
                subscribed: doc.subscribed,
                hidden: !!doc.hidden,
                sortOrder: doc.sortOrder,
                modifyIndex: doc.modifyIndex,
                uidNext: doc.uidNext
            });
        }
    }

    add(entry) {
        this.byId.set(entry._id.toString(), entry);
        this.byPath.set(entry.path, entry);
    }

    remove(entry) {
        this.byId.delete(entry._id.toString());
        this.byPath.delete(entry.path);
    }

    /** A visible mailbox by JMAP id (or creation id resolved before), or null */
    visible(id) {
        const oid = parseId('mailbox', id);
        const entry = oid && this.byId.get(oid.toString());
        return entry && !entry.hidden ? entry : null;
    }

    /** The nearest visible existing ancestor, as Mailbox/get derives parentId */
    parentOf(entry) {
        const segments = entry.path.split('/');
        for (let depth = segments.length - 1; depth > 0; depth--) {
            const parent = this.byPath.get(segments.slice(0, depth).join('/'));
            if (parent && !parent.hidden) {
                return parent;
            }
        }
        return null;
    }

    nameOf(entry) {
        const parent = this.parentOf(entry);
        return parent ? entry.path.slice(parent.path.length + 1) : entry.path;
    }

    /** Every mailbox below the path, hidden ones included */
    descendants(entry) {
        const prefix = entry.path + '/';
        return [...this.byId.values()].filter(other => other.path.startsWith(prefix));
    }

    /** Visible mailboxes whose JMAP parentId is this mailbox */
    children(entry) {
        return this.descendants(entry).filter(other => !other.hidden && this.parentOf(other) === entry);
    }

    /** Renames a mailbox and moves its descendants along, as the handler does */
    rename(entry, path) {
        const moved = [entry, ...this.descendants(entry)];
        const old = entry.path;
        for (const item of moved) {
            this.byPath.delete(item.path);
        }
        for (const item of moved) {
            item.path = path + item.path.slice(old.length);
            this.byPath.set(item.path, item);
        }
    }
}

// handler errors to SetErrors; anything unexpected stays a server failure
function fromHandlerError(err, properties) {
    if (err.code === 'ALREADYEXISTS' || err.code === 11000) {
        return invalidProperties(properties, 'a mailbox with this name already exists');
    }
    if (err.code === 'NONEXISTENT') {
        return new SetError('notFound');
    }
    if (err.code === 'CANNOT' && /ReachedMailboxCountLimit/.test(err.message)) {
        return new SetError('overQuota', 'the maximum number of mailboxes is reached');
    }
    if (err.code === 'CANNOT') {
        return invalidProperties(properties, err.message);
    }
    return err;
}

function setHandlers(args, context) {
    const { mailboxHandler, settingsHandler, database } = context.deps;
    const user = context.account.user;
    const create = isObject(args.create) ? args.create : {};
    // creation id -> {result} or {error}; creation ids being created right now, for cycles
    const createMemo = new Map();
    const creating = new Set();
    // ids destroyed ahead of their turn, and ids being destroyed right now
    const destroyed = new Set();
    const destroying = new Set();
    let tree;
    // read once per call, on the first create
    let maxMailboxes;

    // later reads in this request (state, Mailbox/get, Email visibility) see the change
    const changed = () => invalidateMailCache(context);

    const destroyList = referencedIds(context, Array.isArray(args.destroy) ? args.destroy : []);

    // ---- create

    async function resolveParent(value) {
        if (value === null || value === undefined) {
            return null;
        }
        if (typeof value !== 'string') {
            throw invalidProperties('parentId', 'parentId must be an id or null');
        }
        let id = value;
        if (value.startsWith('#')) {
            const creationId = value.slice(1);
            if (Object.hasOwn(create, creationId) && !createMemo.has(creationId)) {
                if (creating.has(creationId)) {
                    throw invalidProperties('parentId', 'parentId references form a cycle');
                }
                await createOne(create[creationId], creationId).catch(() => false);
            }
            if (createMemo.has(creationId) && createMemo.get(creationId).error) {
                throw invalidProperties('parentId', `the creation of ${creationId} failed`);
            }
            id = resolveId(context, value);
        }
        const parent = id && tree.visible(id);
        if (!parent) {
            throw invalidProperties('parentId', 'no such mailbox');
        }
        return parent;
    }

    function checkCreateProperties(object) {
        const bad = Object.keys(object).filter(key => SERVER_SET.includes(key) || !PROPERTIES.includes(key));
        if (object.role !== undefined && object.role !== null) {
            // roles belong to the mailboxes created with the account
            bad.push('role');
        }
        if (object.sortOrder !== undefined && !validSortOrder(object.sortOrder)) {
            bad.push('sortOrder');
        }
        if (object.isSubscribed !== undefined && typeof object.isSubscribed !== 'boolean') {
            bad.push('isSubscribed');
        }
        if (object.parentId !== undefined && object.parentId !== null && typeof object.parentId !== 'string') {
            bad.push('parentId');
        }
        let name;
        try {
            name = checkName(object.name);
        } catch {
            bad.push('name');
        }
        if (bad.length) {
            throw invalidProperties(bad);
        }
        return name;
    }

    // a mailbox of the same path that this call destroys is destroyed first; true when the path is free
    async function freePath(path) {
        const existing = tree.byPath.get(path);
        if (!existing) {
            return true;
        }
        const id = formatId('mailbox', existing._id);
        if (existing.hidden || !destroyList().has(id) || destroying.has(id)) {
            return false;
        }
        try {
            await destroyOne(id);
            return true;
        } catch {
            return false;
        }
    }

    async function createMailbox(object) {
        const name = checkCreateProperties(object);
        const parent = await resolveParent(object.parentId);
        const path = parent ? `${parent.path}/${name}` : name;
        if (depthOf(path) > MAX_DEPTH) {
            throw invalidProperties(parent ? 'parentId' : 'name', `mailboxes can not be nested more than ${MAX_DEPTH} levels deep`);
        }
        // INBOX is case insensitive over IMAP
        if (!parent && name.toUpperCase() === 'INBOX') {
            throw invalidProperties('name', 'INBOX already exists');
        }
        if (!(await freePath(path))) {
            throw invalidProperties('name', 'a mailbox with this name already exists');
        }
        if (maxMailboxes === undefined) {
            maxMailboxes = await settingsHandler.get('const:max:mailboxes');
        }
        if (tree.byId.size >= maxMailboxes) {
            throw new SetError('overQuota', 'the maximum number of mailboxes is reached');
        }

        const opts = { subscribed: object.isSubscribed !== false };
        if (object.sortOrder !== undefined) {
            opts.sortOrder = object.sortOrder;
        }
        let result;
        try {
            result = await mailboxHandler.createAsync(user, path, opts);
        } catch (err) {
            throw fromHandlerError(err, ['name']);
        }
        changed();
        const entry = { _id: result.id, user, path, subscribed: opts.subscribed, hidden: false, sortOrder: opts.sortOrder, modifyIndex: 1, uidNext: 1 };
        tree.add(entry);

        // the server set properties and every property the client did not send (RFC 8620 5.3)
        const created = { id: formatId('mailbox', entry._id), totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: rightsOf(entry) };
        const defaults = { parentId: null, role: null, sortOrder: 0, isSubscribed: true };
        for (const [key, value] of Object.entries(defaults)) {
            if (!Object.hasOwn(object, key)) {
                created[key] = value;
            }
        }
        if (name !== object.name) {
            created.name = name;
        }
        return created;
    }

    // memoised, so a creation done early for a dependent object is reported once in its own turn
    async function createOne(object, creationId) {
        if (createMemo.has(creationId)) {
            const memo = createMemo.get(creationId);
            if (memo.error) {
                throw memo.error;
            }
            return memo.result;
        }
        creating.add(creationId);
        try {
            if (!isObject(object)) {
                throw invalidProperties([], 'the object must be a JSON object');
            }
            const result = await createMailbox(object);
            createMemo.set(creationId, { result });
            setOwn(context.createdIds, creationId, result.id);
            return result;
        } catch (err) {
            createMemo.set(creationId, { error: err });
            throw err;
        } finally {
            creating.delete(creationId);
        }
    }

    // ---- update

    async function currentObject(entry, wantCounts) {
        const parent = tree.parentOf(entry);
        const object = {
            id: formatId('mailbox', entry._id),
            name: tree.nameOf(entry),
            parentId: parent ? formatId('mailbox', parent._id) : null,
            role: roleOf(entry),
            sortOrder: Number.isInteger(entry.sortOrder) ? entry.sortOrder : 0,
            myRights: rightsOf(entry),
            isSubscribed: entry.subscribed !== false
        };
        if (wantCounts) {
            Object.assign(object, await mailboxCounts(context.deps, entry));
        }
        return object;
    }

    // the new path for a changed name and parent, judged against the current tree
    function plannedPath(entry, current, next, touched) {
        const changedProperties = ['name', 'parentId'].filter(key => touched.has(key) && next[key] !== current[key]);
        if (entry.path === 'INBOX') {
            throw new SetError('forbidden', 'the INBOX can not be renamed or moved');
        }
        const parent = next.parentId === null ? null : tree.visible(next.parentId);
        const path = parent ? `${parent.path}/${next.name}` : next.name;
        const below = Math.max(0, ...tree.descendants(entry).map(item => depthOf(item.path) - depthOf(entry.path)));
        if (depthOf(path) + below > MAX_DEPTH) {
            throw invalidProperties(
                changedProperties.includes('parentId') ? 'parentId' : 'name',
                `mailboxes can not be nested more than ${MAX_DEPTH} levels deep`
            );
        }
        if (!parent && next.name.toUpperCase() === 'INBOX') {
            throw invalidProperties('name', 'INBOX already exists');
        }
        const existing = tree.byPath.get(path);
        if (existing && existing !== entry) {
            throw invalidProperties(changedProperties, 'a mailbox with this name already exists');
        }
        return { path, changedProperties };
    }

    // the new parent of an update, or invalidProperties: it must exist and not be the mailbox or below it
    function checkParent(entry, value) {
        if (value === null) {
            return null;
        }
        const id = typeof value === 'string' ? resolveId(context, value) : null;
        const parent = id && tree.visible(id);
        if (!parent || parent === entry || parent.path.startsWith(entry.path + '/')) {
            throw invalidProperties('parentId', parent ? 'a mailbox can not be moved below itself' : 'no such mailbox');
        }
        return formatId('mailbox', parent._id);
    }

    async function update(id, patch) {
        const entry = tree.visible(id);
        if (!entry) {
            throw new SetError('notFound');
        }
        const touchesCounts = Object.keys(patch).some(key => COUNTS.includes(key.split('/')[0]));
        const current = await currentObject(entry, touchesCounts);
        const { object: next, properties: touched } = applyPatch(current, patch, { properties: PROPERTIES });

        const bad = [];
        for (const property of touched) {
            if (SERVER_SET.includes(property) || property === 'role') {
                // read only, but writing back the current value is accepted
                if (!isDeepStrictEqual(next[property], current[property])) {
                    bad.push(property);
                }
            } else if (property === 'name') {
                if (next.name !== current.name) {
                    try {
                        next.name = checkName(next.name);
                    } catch {
                        bad.push('name');
                    }
                }
            } else if (property === 'parentId') {
                try {
                    next.parentId = next.parentId === current.parentId ? next.parentId : checkParent(entry, next.parentId);
                } catch {
                    bad.push('parentId');
                }
            } else if (property === 'sortOrder') {
                if (!validSortOrder(next.sortOrder)) {
                    bad.push('sortOrder');
                }
            } else if (property === 'isSubscribed' && typeof next.isSubscribed !== 'boolean') {
                bad.push('isSubscribed');
            }
        }
        if (bad.length) {
            throw invalidProperties(bad);
        }

        const updates = {};
        if (next.name !== current.name || next.parentId !== current.parentId) {
            updates.path = plannedPath(entry, current, next, touched).path;
        }
        if (next.isSubscribed !== current.isSubscribed) {
            updates.subscribed = next.isSubscribed;
        }
        if (next.sortOrder !== current.sortOrder) {
            updates.sortOrder = next.sortOrder;
        }
        if (!Object.keys(updates).length) {
            return null;
        }

        try {
            await mailboxHandler.updateAsync(user, entry._id, updates);
        } catch (err) {
            throw fromHandlerError(
                err,
                ['name', 'parentId'].filter(key => touched.has(key))
            );
        }
        changed();
        if (updates.path) {
            tree.rename(entry, updates.path);
        }
        if ('subscribed' in updates) {
            entry.subscribed = updates.subscribed;
        }
        if ('sortOrder' in updates) {
            entry.sortOrder = updates.sortOrder;
        }
        return null;
    }

    // ---- destroy

    // true when the mailbox holds an Email visible over JMAP (not \Deleted, not waiting for deletion)
    async function hasEmail(entry) {
        const message = await database
            .collection('messages')
            .findOne(
                { mailbox: entry._id, undeleted: true, $nor: [{ exp: true, rdate: { $lte: Date.now() } }] },
                { projection: { _id: true }, hint: 'mailbox_undeleted_flag', maxTimeMS: consts.DB_MAX_TIME_MESSAGES_SEARCH }
            );
        return !!message;
    }

    async function destroyOne(id) {
        if (destroyed.has(id)) {
            return;
        }
        const entry = tree.visible(id);
        if (!entry) {
            throw new SetError('notFound');
        }
        if (entry.path === 'INBOX' || entry.specialUse) {
            throw new SetError('forbidden', 'the INBOX and special use mailboxes can not be destroyed');
        }
        destroying.add(id);
        try {
            const children = tree.children(entry);
            if (children.length) {
                // children destroyed in the same call go first, whatever the order of the ids
                const list = destroyList();
                const childIds = children.map(child => formatId('mailbox', child._id));
                if (!childIds.every(childId => list.has(childId) && !destroying.has(childId))) {
                    throw new SetError('mailboxHasChild');
                }
                for (const childId of childIds) {
                    await destroyOne(childId).catch(() => false);
                }
                if (tree.children(entry).length) {
                    throw new SetError('mailboxHasChild');
                }
            }
            if (args.onDestroyRemoveEmails !== true && (await hasEmail(entry))) {
                throw new SetError('mailboxHasEmail');
            }
            try {
                await mailboxHandler.delAsync(user, entry._id);
            } catch (err) {
                throw err.code === 'CANNOT' ? new SetError('forbidden', err.message) : fromHandlerError(err, []);
            }
            changed();
            tree.remove(entry);
            destroyed.add(id);
        } finally {
            destroying.delete(id);
        }
    }

    return {
        arguments: ['onDestroyRemoveEmails'],
        async prepare() {
            if (args.onDestroyRemoveEmails !== undefined && args.onDestroyRemoveEmails !== null && typeof args.onDestroyRemoveEmails !== 'boolean') {
                throw invalidArguments('onDestroyRemoveEmails must be a boolean');
            }
            // update is Id[PatchObject]: a patch that is not an object is a malformed argument
            if (isObject(args.update) && !Object.values(args.update).every(isObject)) {
                throw invalidArguments('every patch must be an object');
            }
            const { withHidden } = await loadMailboxes(context);
            tree = new MailboxTree([...withHidden.values()]);
        },
        state: async () => (await mailState(context)).state,
        create: createOne,
        update,
        destroy: destroyOne
    };
}

const set = (args, context) => runSet(args, context, setHandlers(args, context));

module.exports = {
    capability: URN.mail,
    methods: { 'Mailbox/set': set },
    checkName,
    MailboxTree
};
