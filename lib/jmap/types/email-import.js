'use strict';

// Email/import (RFC 8621 4.8): stores message blobs (uploads, stored messages, attached messages) as
// new Emails. The checks and the store are the ones of Email/set create (email-set.js): every message
// is stored through MessageHandler, like IMAP APPEND and the REST API upload, so it is journaled, quota
// accounted, counted against the daily upload limit, encrypted when the account asks for it, audited
// and pushed. Ids are not content derived: importing the same blob twice gives two Emails, never
// alreadyExists.

const { URN } = require('../capabilities');
const { invalidArguments } = require('../errors');
const { requireAccount, isObject } = require('./common');
const { SetError, invalidProperties } = require('../set-errors');
const { runSet } = require('../set');
const { mailState } = require('../state');
const { readBlob } = require('../blob');
const { parseUTCDate } = require('../utcdate');
const { looksLikeMessage, headerBlock } = require('../parsed-message');
const { headerFields } = require('../email-headers');
const { checkMailboxIds, checkKeywords, storeEmail, refreshMailboxes } = require('./email-set');
const parseDate = require('../../../imap-core/lib/parse-date');
const consts = require('../../consts');

const PROPERTIES = ['blobId', 'mailboxIds', 'keywords', 'receivedAt'];

/**
 * Checks the properties of an EmailImport object that need no lookup (mailboxIds and keywords are
 * checked by checkMailboxIds() and checkKeywords()).
 *
 * @returns {{receivedAt: Date|null}}
 * @throws {SetError} invalidProperties
 */
function checkImport(object) {
    const unknown = Object.keys(object).filter(key => !PROPERTIES.includes(key));
    if (unknown.length) {
        throw invalidProperties(unknown, 'unknown properties');
    }
    if (typeof object.blobId !== 'string') {
        // both required properties are reported when both are missing
        const mailboxIds = isObject(object.mailboxIds) && Object.keys(object.mailboxIds).length;
        throw invalidProperties(mailboxIds ? ['blobId'] : ['blobId', 'mailboxIds'], 'blobId is required');
    }
    if (object.receivedAt === undefined || object.receivedAt === null) {
        return { receivedAt: null };
    }
    const receivedAt = parseUTCDate(object.receivedAt);
    if (!receivedAt) {
        throw invalidProperties('receivedAt', 'receivedAt must be a UTCDate');
    }
    return { receivedAt };
}

// the date of the most recent (topmost) Received header of a message, or null
function receivedDate(messageHandler, raw) {
    const header = messageHandler.indexer.parseMimeTree(Buffer.concat([headerBlock(raw), Buffer.from('\r\n\r\n')]));
    const field = headerFields(header).find(entry => entry.name.trim().toLowerCase() === 'received');
    if (!field) {
        return null;
    }
    const value = field.value.replace(/\r?\n[ \t]*/g, ' ');
    const semicolon = value.lastIndexOf(';');
    if (semicolon < 0) {
        return null;
    }
    const date = parseDate(value.slice(semicolon + 1).trim(), null);
    return date && !isNaN(date.getTime()) ? date : null;
}

function importer(context, usage) {
    return async object => {
        const checked = checkImport(object);
        const mailbox = await checkMailboxIds(context, object.mailboxIds);
        const keywords = await checkKeywords(context, object.keywords);

        const limit = context.limits.maxSizeMessage || consts.MAX_ALLOWED_MESSAGE_SIZE;
        const raw = await readBlob(context, object.blobId, limit).catch(err =>
            Promise.reject(err.code === 'BlobTooLarge' ? new SetError('tooLarge', `the message is larger than ${limit} octets`, { maxSize: limit }) : err)
        );
        // RFC 8621 4.8: an unknown blob is invalidProperties, not blobNotFound
        if (!raw) {
            throw invalidProperties('blobId', 'no such blob');
        }
        if (!looksLikeMessage(raw)) {
            throw new SetError('invalidEmail', 'the blob is not an RFC 5322 message');
        }

        const receivedAt = checked.receivedAt || receivedDate(context.deps.messageHandler, raw) || new Date();
        return storeEmail(context, { raw, mailbox, keywords, receivedAt, usage, transtype: 'IMPORT' });
    };
}

async function emailImport(args, context) {
    requireAccount(args, context);
    for (const key of Object.keys(args)) {
        if (!['accountId', 'ifInState', 'emails'].includes(key)) {
            throw invalidArguments(`unknown argument ${key}`);
        }
    }
    if (!isObject(args.emails)) {
        throw invalidArguments('emails must be an object');
    }
    // storage usage, read on the first import and kept up to date by the ones after it
    const usage = {};
    const response = await runSet({ accountId: args.accountId, ifInState: args.ifInState, create: args.emails }, context, {
        state: async () => (await mailState(context)).state,
        create: importer(context, usage)
    });
    refreshMailboxes(context, response);
    return {
        accountId: response.accountId,
        oldState: response.oldState,
        newState: response.newState,
        created: response.created,
        notCreated: response.notCreated
    };
}

module.exports = { capability: URN.mail, methods: { 'Email/import': emailImport }, checkImport };
