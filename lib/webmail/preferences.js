'use strict';

// Preferences of a webmail client, one document per user in webmail.preferences ({_id: user}).
// Every key is declared here with its type, so a client can not store arbitrary data under the
// user: unknown keys and values of the wrong type are refused. Adding a setting is one entry in
// PREFERENCES. Values that are not set are left out of the document and the client applies its
// own default.

const SCHEMA_VERSION = 1;

const enumOf = (...values) => ({ type: 'enum', values });
const bool = () => ({ type: 'boolean' });
const int = (min, max) => ({ type: 'integer', min, max });
const str = (maxLength, pattern) => ({ type: 'string', maxLength, pattern });
const strList = (maxItems, maxLength) => ({ type: 'list', maxItems, maxLength });

const PREFERENCES = {
    // appearance
    theme: enumOf('system', 'light', 'dark'),
    accent: enumOf('blue', 'red', 'purple'),
    density: enumOf('comfortable', 'default', 'compact'),
    readingPane: enumOf('right', 'bottom', 'off'),
    listSort: enumOf('date', 'unreadFirst', 'starredFirst', 'readFirst'),
    threading: bool(),
    showSizeColumn: bool(),
    showContactsPanel: bool(),
    contactOrder: enumOf('name', 'lastUsed'),
    folderPaneWidth: int(160, 640),
    listPaneSize: int(200, 1600),
    collapsedFolders: strList(1500, 64),
    alphabeticalFolders: bool(),

    // reading
    markReadDelay: int(-1, 60),
    openNextAfterAction: bool(),
    remoteContent: enumOf('ask', 'contacts', 'always'),

    // composing
    enterKey: enumOf('newParagraph', 'newLine'),
    toolbarPosition: enumOf('top', 'bottom'),
    fontFamily: str(64, /^[\w ,'"-]*$/),
    fontSize: int(8, 36),
    undoSendSeconds: int(0, 30),

    // general
    language: enumOf('et', 'en', 'ru', 'fi'),
    timeZone: str(64, /^[A-Za-z0-9_+\-/]*$/),
    keyboardShortcuts: bool(),
    notifications: bool(),
    passkeyOfferDismissed: bool()
};

const MAX_DOCUMENT_BYTES = 64 * 1024;

function invalid(message, key) {
    const err = new Error(message);
    err.responseCode = 400;
    err.code = 'InputValidationError';
    if (key) {
        err.details = { [key]: message };
    }
    return err;
}

function checkValue(key, spec, value) {
    switch (spec.type) {
        case 'enum':
            if (!spec.values.includes(value)) {
                throw invalid(`${key} must be one of ${spec.values.join(', ')}`, key);
            }
            return value;
        case 'boolean':
            if (typeof value !== 'boolean') {
                throw invalid(`${key} must be a boolean`, key);
            }
            return value;
        case 'integer':
            if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
                throw invalid(`${key} must be an integer from ${spec.min} to ${spec.max}`, key);
            }
            return value;
        case 'string':
            if (typeof value !== 'string' || value.length > spec.maxLength || (spec.pattern && !spec.pattern.test(value))) {
                throw invalid(`${key} must be a string of at most ${spec.maxLength} allowed characters`, key);
            }
            return value;
        case 'list':
            if (!Array.isArray(value) || value.length > spec.maxItems) {
                throw invalid(`${key} must be a list of at most ${spec.maxItems} strings`, key);
            }
            for (const item of value) {
                if (typeof item !== 'string' || !item.length || item.length > spec.maxLength) {
                    throw invalid(`${key} must hold strings of 1 to ${spec.maxLength} characters`, key);
                }
            }
            return Array.from(new Set(value));
    }
    throw invalid(`${key} has an unknown type`, key);
}

/**
 * Validates a partial update. A value of null removes the key, so the client default applies again.
 *
 * @param {Object} changes key -> value or null
 * @returns {{set: Object, unset: string[]}}
 */
function validateChanges(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        throw invalid('preferences must be an object', 'preferences');
    }
    const set = {};
    const unset = [];
    for (const [key, value] of Object.entries(changes)) {
        if (!Object.prototype.hasOwnProperty.call(PREFERENCES, key)) {
            throw invalid(`Unknown preference ${key}`, key);
        }
        if (value === null) {
            unset.push(key);
            continue;
        }
        set[key] = checkValue(key, PREFERENCES[key], value);
    }
    if (Buffer.byteLength(JSON.stringify(set)) > MAX_DOCUMENT_BYTES) {
        throw invalid('preferences are too large', 'preferences');
    }
    return { set, unset };
}

class WebmailPreferences {
    constructor(db) {
        this.collection = db.database.collection('webmail.preferences');
    }

    async get(user) {
        const doc = await this.collection.findOne({ _id: user });
        return format(doc);
    }

    async update(user, changes) {
        const { set, unset } = validateChanges(changes);
        const update = {
            $set: Object.assign({ v: SCHEMA_VERSION, updated: new Date() }, ...Object.entries(set).map(([key, value]) => ({ [`values.${key}`]: value })))
        };
        if (unset.length) {
            update.$unset = Object.fromEntries(unset.map(key => [`values.${key}`, '']));
        }
        const doc = await this.collection.findOneAndUpdate({ _id: user }, update, { upsert: true, returnDocument: 'after' });
        return format(doc);
    }

    async reset(user) {
        const result = await this.collection.deleteOne({ _id: user });
        return result.deletedCount > 0;
    }
}

function format(doc) {
    return {
        preferences: (doc && doc.values) || {},
        version: SCHEMA_VERSION,
        updated: (doc && doc.updated) || null
    };
}

module.exports = { WebmailPreferences, PREFERENCES, SCHEMA_VERSION, validateChanges };
