'use strict';

const Joi = require('joi');
const { booleanSchema } = require('../../schemas');
const { mailboxId, messageId } = require('./general-schemas');

const Address = Joi.object({
    name: Joi.string().empty('').max(255).required().description('Name of the sender/recipient'),
    address: Joi.string().email({ tlds: false }).required().description('Address of the sender/recipient')
}).$_setFlag('objectName', 'Address');

const AddressOptionalName = Joi.object({
    name: Joi.string().empty('').max(255).description('Name of the sender'),
    address: Joi.string().email({ tlds: false }).required().description('Address of the sender')
}).$_setFlag('objectName', 'AddressOptionalName');

const AddressOptionalNameArray = Joi.array().items(AddressOptionalName);

const Header = Joi.object({
    key: Joi.string().empty('').max(255).description("Header key ('X-Mailer')"),
    value: Joi.string()
        .empty('')
        .max(100 * 1024)
        .description("Header value ('My Awesome Mailing Service')")
}).$_setFlag('objectName', 'Header');

const Attachment = Joi.object({
    filename: Joi.string().empty('').max(255).description('Attachment filename'),
    contentType: Joi.string().empty('').max(255).description('MIME type for the attachment file'),
    encoding: Joi.string().empty('').default('base64').description('Encoding to use to store the attachments'),
    contentTransferEncoding: Joi.string().empty('').description('Transfer encoding'),
    content: Joi.string().required().description('Base64 encoded attachment content'),
    cid: Joi.string().empty('').max(255).description('Content-ID value if you want to reference to this attachment from HTML formatted message'),
    contentDisposition: Joi.string().empty('').trim().lowercase().valid('inline', 'attachment').description('Content Disposition')
}).$_setFlag('objectName', 'Attachment');

const ReferenceWithAttachments = Joi.object({
    mailbox: mailboxId,
    id: messageId,
    action: Joi.string().valid('reply', 'replyAll', 'forward').required().description('Either reply, replyAll or forward'),
    attachments: Joi.alternatives()
        .try(
            booleanSchema,
            Joi.array().items(
                Joi.string()
                    .regex(/^ATT\d+$/i)
                    .uppercase()
            )
        )
        .description(
            "If true, then includes all attachments from the original message. If it is an array of attachment ID's includes attachments from the list"
        )
}).$_setFlag('objectName', 'ReferenceWithAttachments');

const ReferenceWithoutAttachments = Joi.object({
    mailbox: mailboxId,
    id: messageId,
    action: Joi.string().valid('reply', 'replyAll', 'forward').required().description('Either reply, replyAll or forward')
}).$_setFlag('objectName', 'Reference');

const Bimi = Joi.object({
    domain: Joi.string().domain().required().description('Domain name for the BIMI record. It does not have to be the same as the From address.'),
    selector: Joi.string().empty('').max(255).description('Optional BIMI selector')
}).$_setFlag('objectName', 'Bimi');

module.exports = {
    Address,
    AddressOptionalNameArray,
    AddressOptionalName,
    Header,
    Attachment,
    ReferenceWithAttachments,
    Bimi,
    ReferenceWithoutAttachments
};
