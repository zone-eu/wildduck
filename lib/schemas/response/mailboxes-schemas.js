'use strict';

const Joi = require('joi');
const { mailboxId } = require('../request/general-schemas');
const { booleanSchema } = require('../../schemas');

const GetMailboxesResult = Joi.object({
    id: mailboxId,
    name: Joi.string().required().description('Name for the mailbox (unicode string)'),
    path: Joi.string().required().description('Full path of the mailbox, folders are separated by slashes, ends with the mailbox name (unicode string)'),
    specialUse: Joi.string().required().description('Either special use identifier or null. One of Drafts, Junk, Sent or Trash'),
    modifyIndex: Joi.number().required().description('Modification sequence number. Incremented on every change in the mailbox.'),
    subscribed: booleanSchema.required().description('Mailbox subscription status. IMAP clients may unsubscribe from a folder.'),
    retention: Joi.number().description(
        'Default retention policy for this mailbox (in ms). If set then messages added to this mailbox will be automatically deleted after retention time.'
    ),
    hidden: booleanSchema.required().description('Is the folder hidden or not'),
    encryptMessages: booleanSchema.default(false).required().description('If true then messages in this mailbox are encrypted'),
    total: Joi.number().required().description('How many messages are stored in this mailbox'),
    unseen: Joi.number().required().description('How many unseen messages are stored in this mailbox'),
    size: Joi.number().description('Total size of mailbox in bytes.')
});

module.exports = {
    GetMailboxesResult
};
