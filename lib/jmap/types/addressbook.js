'use strict';

// AddressBook/get, AddressBook/changes and AddressBook/set (RFC 9610 2).
//
// The address books of a user live in the addressbooks collection (lib/contact-handler.js). The default
// one is created on the first use of a contacts method. The address register (the addresses the user
// sent mail to or received mail from) is shown as one more, read only address book with a fixed id;
// its cards are synthesised from the register entries (contactcard.js). There is no sharing (RFC 9670
// is not implemented): shareWith is always null and the owner has every right, except that the default
// address book can not be destroyed while it is the default.

const { URN } = require('../capabilities');
const { formatId, parseId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { SetError, invalidProperties } = require('../set-errors');
const { requireAccount, checkArguments } = require('./common');
const { changeLogFor } = require('../changelog');
const { applyPatch } = require('../patch');
const { runSet, resolveId } = require('../set');
const { maxChangesOf } = require('../state');
const { ContactHandler, BOOK_TYPE, BOOKS, DEFAULT_LIMITS } = require('../../contact-handler');

const TYPE = BOOK_TYPE;
const PROPERTIES = ['id', 'name', 'description', 'sortOrder', 'isDefault', 'isSubscribed', 'shareWith', 'myRights'];
const WRITABLE = ['name', 'description', 'sortOrder', 'isSubscribed'];
// the read only address book of the address register
const REGISTER_ID = 'Aregister';
const REGISTER_NAME = 'Autosaved';
const MAX_NAME = 255;
const MAX_DESCRIPTION = 64 * 1024;

/** The contacts storage of the service, with the [jmap.contacts] limits */
function contactsOf(context) {
    if (!context.deps.contactHandler) {
        context.deps.contactHandler = new ContactHandler({ database: context.deps.database, limits: context.options.contacts });
    }
    return context.deps.contactHandler;
}

/** The address books of the account, loaded once per request (the default one is created on first use) */
function loadBooks(context) {
    if (!context.cache.addressBooks) {
        context.cache.addressBooks = contactsOf(context).listBooks(context.account.user);
    }
    return context.cache.addressBooks;
}

const formatBookId = id => (typeof id === 'string' ? id : formatId('addressBook', id));

/** The stored address book a JMAP id names, the register book (REGISTER_ID) or null */
async function findBook(context, id) {
    if (id === REGISTER_ID) {
        return REGISTER_ID;
    }
    const objectId = parseId('addressBook', id);
    return (objectId && (await loadBooks(context)).find(book => book._id.equals(objectId))) || null;
}

const rights = (mayWrite, mayDelete) => ({ mayRead: true, mayWrite, mayShare: mayWrite, mayDelete });

function toAddressBook(book, properties) {
    const values =
        book === REGISTER_ID
            ? {
                  id: REGISTER_ID,
                  name: REGISTER_NAME,
                  description: null,
                  sortOrder: 0,
                  isDefault: false,
                  isSubscribed: true,
                  shareWith: null,
                  myRights: rights(false, false)
              }
            : {
                  id: formatBookId(book._id),
                  name: book.name,
                  description: book.description === undefined ? null : book.description,
                  sortOrder: book.sortOrder || 0,
                  isDefault: !!book.isDefault,
                  isSubscribed: book.isSubscribed !== false,
                  shareWith: null,
                  myRights: rights(true, !book.isDefault)
              };
    return Object.fromEntries(properties.map(property => [property, values[property]]));
}

const state = context => changeLogFor(context).state(context.account.user, context.account.id, TYPE);

// ---------------------------------------------------------------- get and changes

function checkProperties(properties, known) {
    const list = properties === undefined || properties === null ? known : properties;
    if (!Array.isArray(list) || list.some(property => !known.includes(property))) {
        throw invalidArguments('unknown property');
    }
    return ['id', ...list.filter(property => property !== 'id')];
}

function checkIds(args, context) {
    if (args.ids !== undefined && args.ids !== null && !(Array.isArray(args.ids) && args.ids.every(id => typeof id === 'string'))) {
        throw invalidArguments('ids must be a list of ids');
    }
    if (args.ids && args.ids.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
}

async function get(args, context) {
    checkArguments(args, ['accountId', 'ids', 'properties']);
    requireAccount(args, context);
    const properties = checkProperties(args.properties, PROPERTIES);
    checkIds(args, context);
    const books = [...(await loadBooks(context)), REGISTER_ID];
    const result = { accountId: context.account.id, state: await state(context), list: [], notFound: [] };
    if (args.ids === undefined || args.ids === null) {
        result.list = books.map(book => toAddressBook(book, properties));
        return result;
    }
    for (const reference of args.ids) {
        const id = resolveId(context, reference);
        const book = id && (await findBook(context, id));
        if (book) {
            result.list.push(toAddressBook(book, properties));
        } else {
            result.notFound.push(reference);
        }
    }
    return result;
}

async function changes(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    const maxChanges = maxChangesOf(args);
    await loadBooks(context);
    const result = await changeLogFor(context).changes({
        user: context.account.user,
        accountId: context.account.id,
        type: TYPE,
        collection: BOOKS,
        sinceState: args.sinceState,
        maxChanges: Math.min(maxChanges, context.limits.maxObjectsInGet),
        formatId: formatBookId
    });
    return Object.assign({ accountId: context.account.id }, result);
}

// ---------------------------------------------------------------- set

/** Validates the writable properties of a create or of a patched object */
function checkValues(object) {
    const values = {};
    if (object.name !== undefined) {
        if (typeof object.name !== 'string' || !object.name.length || Buffer.byteLength(object.name) > MAX_NAME || object.name.includes('\x00')) {
            throw invalidProperties('name', `name must be a string of 1 to ${MAX_NAME} octets`);
        }
        values.name = object.name;
    }
    if (object.description !== undefined) {
        const valid = object.description === null || (typeof object.description === 'string' && Buffer.byteLength(object.description) <= MAX_DESCRIPTION);
        if (!valid) {
            throw invalidProperties('description', 'description must be a string or null');
        }
        values.description = object.description;
    }
    if (object.sortOrder !== undefined) {
        if (!Number.isInteger(object.sortOrder) || object.sortOrder < 0 || object.sortOrder > 2147483647) {
            throw invalidProperties('sortOrder', 'sortOrder must be an integer from 0 to 2^31 - 1');
        }
        values.sortOrder = object.sortOrder;
    }
    if (object.isSubscribed !== undefined) {
        if (typeof object.isSubscribed !== 'boolean') {
            throw invalidProperties('isSubscribed', 'isSubscribed must be a boolean');
        }
        values.isSubscribed = object.isSubscribed;
    }
    return values;
}

// server set properties a create may name only with their default value
const CREATE_DEFAULTS = { shareWith: null };

function checkCreate(object) {
    const bad = Object.keys(object).filter(
        key => !WRITABLE.includes(key) && !(Object.hasOwn(CREATE_DEFAULTS, key) && JSON.stringify(object[key]) === JSON.stringify(CREATE_DEFAULTS[key]))
    );
    if (bad.length) {
        throw invalidProperties(bad, 'server set or unknown properties');
    }
    if (object.name === undefined || object.name === null) {
        throw invalidProperties('name', 'name is required');
    }
    return checkValues(object);
}

/** The id onSuccessSetIsDefault names, resolved, or null */
function defaultTarget(args, context) {
    const value = args.onSuccessSetIsDefault;
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        throw invalidArguments('onSuccessSetIsDefault must be an id');
    }
    return resolveId(context, value);
}

function setHandlers(context, args) {
    const user = context.account.user;
    const contacts = contactsOf(context);
    const removeContents = args.onDestroyRemoveContents === true;
    const owned = async id => {
        const book = await findBook(context, id);
        if (!book) {
            throw new SetError('notFound');
        }
        if (book === REGISTER_ID) {
            throw new SetError('forbidden', 'the address register can not be changed');
        }
        return book;
    };
    return {
        arguments: ['onDestroyRemoveContents', 'onSuccessSetIsDefault'],
        state: () => state(context),
        prepare: async () => {
            if (args.onDestroyRemoveContents !== undefined && typeof args.onDestroyRemoveContents !== 'boolean') {
                throw invalidArguments('onDestroyRemoveContents must be a boolean');
            }
            defaultTarget(args, context);
            await loadBooks(context);
        },

        async create(object) {
            const values = checkCreate(object);
            const books = await loadBooks(context);
            if (books.length >= contacts.limits.maxAddressBooks) {
                throw new SetError('overQuota', `an account has at most ${contacts.limits.maxAddressBooks} address books`);
            }
            const book = await contacts.createBook(user, values);
            books.push(book);
            // the server set and defaulted properties the client did not give
            return Object.fromEntries(Object.entries(toAddressBook(book, PROPERTIES)).filter(([key]) => key === 'id' || !(key in object)));
        },

        async update(id, patch) {
            const book = await owned(id);
            if (Object.keys(patch).some(key => key.startsWith('shareWith/'))) {
                // there are no principals to share with (RFC 9670 is not implemented)
                throw invalidProperties('shareWith', 'address books can not be shared');
            }
            const current = toAddressBook(book, PROPERTIES);
            const { object: patched, properties } = applyPatch(current, patch, { properties: PROPERTIES });
            const readOnly = [...properties].filter(
                property => !WRITABLE.includes(property) && JSON.stringify(patched[property]) !== JSON.stringify(current[property])
            );
            if (readOnly.length) {
                throw invalidProperties(readOnly, 'these properties can not be changed');
            }
            if (patched.name === null) {
                throw invalidProperties('name', 'name can not be null');
            }
            const changed = WRITABLE.filter(property => properties.has(property));
            const values = checkValues(Object.fromEntries(changed.map(property => [property, patched[property]])));
            if (!Object.keys(values).some(property => values[property] !== current[property])) {
                return null;
            }
            await contacts.updateBook(user, book, values);
            return null;
        },

        async destroy(id) {
            const book = await owned(id);
            if (book.isDefault) {
                throw new SetError('forbidden', 'the default address book can not be destroyed');
            }
            if (!removeContents && (await contacts.hasCards(user, book))) {
                throw new SetError('addressBookHasContents', 'the address book has cards');
            }
            await contacts.destroyBook(user, book);
            const books = await loadBooks(context);
            books.splice(books.indexOf(book), 1);
        }
    };
}

/**
 * onSuccessSetIsDefault (RFC 9610 2.3): applied when every create, update and destroy succeeded; an
 * unknown or not permitted id is ignored without an error. The changed address books are reported.
 */
async function moveDefault(context, args, response) {
    const target = defaultTarget(args, context);
    if (!target || response.notCreated || response.notUpdated || response.notDestroyed) {
        return false;
    }
    const book = await findBook(context, target);
    const books = await loadBooks(context);
    const current = books.find(entry => entry.isDefault);
    if (!book || book === REGISTER_ID || book.isDefault || !current) {
        return false;
    }
    await contactsOf(context).moveDefault(context.account.user, current, book);
    const report = (doc, values) => {
        const id = formatBookId(doc._id);
        const created = Object.entries(response.created || {}).find(([, entry]) => entry.id === id);
        if (created) {
            Object.assign(created[1], values);
        } else {
            response.updated = response.updated || {};
            response.updated[id] = Object.assign(response.updated[id] || {}, values);
        }
    };
    report(current, { isDefault: false, myRights: rights(true, true) });
    report(book, { isDefault: true, myRights: rights(true, false) });
    return true;
}

async function set(args, context) {
    const response = await runSet(args, context, setHandlers(context, args));
    const moved = await moveDefault(context, args, response);
    if (moved) {
        response.newState = await state(context);
        if (context.deps.notifier) {
            context.deps.notifier.fire(context.account.user);
        }
    }
    return response;
}

const pushStates = async context => ({ [TYPE]: await state(context) });

module.exports = {
    capability: URN.contacts,
    // RFC 9610 1.4.1
    accountCapability: context => {
        const limits = Object.assign({}, DEFAULT_LIMITS, context.options.contacts || {});
        return { maxAddressBooksPerCard: limits.maxAddressBooksPerCard || null, mayCreateAddressBook: true };
    },
    methods: { 'AddressBook/get': get, 'AddressBook/changes': changes, 'AddressBook/set': set },
    pushTypes: [TYPE],
    pushStates,
    contactsOf,
    loadBooks,
    findBook,
    formatBookId,
    REGISTER_ID
};
