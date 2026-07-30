'use strict';

const Address = {
    type: 'object',
    title: 'Address',
    additionalProperties: false,
    properties: {
        name: { type: 'string', maxLength: 255, minLength: 1, wdEmpty: true, wdRequired: true, description: 'Name of the sender/recipient' },
        address: { type: 'string', wdValidator: 'email', wdRequired: true, description: 'Address of the sender/recipient' }
    },
    required: ['address']
};

const AddressOptionalName = {
    type: 'object',
    title: 'AddressOptionalName',
    additionalProperties: false,
    properties: {
        name: { type: 'string', maxLength: 255, minLength: 1, wdEmpty: true, description: 'Name of the sender' },
        address: { type: 'string', wdValidator: 'email', wdRequired: true, description: 'Address of the sender' }
    },
    required: ['address']
};

const AddressOptionalNameArray = {
    type: 'array',
    items: AddressOptionalName
};

const Header = {
    type: 'object',
    title: 'Header',
    additionalProperties: false,
    properties: {
        key: { type: 'string', maxLength: 255, minLength: 1, wdEmpty: true, description: "Header key ('X-Mailer')" },
        value: { type: 'string', maxLength: 100 * 1024, minLength: 1, wdEmpty: true, description: "Header value ('My Awesome Mailing Service')" }
    }
};

const Attachment = {
    type: 'object',
    title: 'Attachment',
    additionalProperties: false,
    properties: {
        filename: { type: 'string', maxLength: 255, minLength: 1, wdEmpty: true, description: 'Attachment filename' },
        contentType: { type: 'string', maxLength: 255, minLength: 1, wdEmpty: true, description: 'MIME type for the attachment file' },
        encoding: { type: 'string', minLength: 1, wdEmpty: true, default: 'base64', description: 'Encoding to use to store the attachments' },
        contentTransferEncoding: { type: 'string', minLength: 1, wdEmpty: true, description: 'Transfer encoding' },
        content: { type: 'string', wdRequired: true, description: 'Base64 encoded attachment content' },
        cid: {
            type: 'string',
            maxLength: 255,
            minLength: 1,
            wdEmpty: true,
            description: 'Content-ID value if you want to reference to this attachment from HTML formatted message'
        },
        contentDisposition: {
            type: 'string',
            enum: ['inline', 'attachment'],
            wdEmpty: true,
            wdTrim: true,
            wdLowercase: true,
            description: 'Content Disposition'
        }
    },
    required: ['content']
};

const referenceMailbox = {
    type: 'string',
    pattern: '^[0-9a-f]{24}$',
    minLength: 24,
    maxLength: 24,
    wdLowercase: true,
    wdRequired: true,
    description: 'ID of the Mailbox'
};

const referenceMessage = {
    type: 'number',
    minimum: 1,
    wdType: 'number',
    wdRequired: true,
    description: 'Message ID'
};

const referenceAction = {
    type: 'string',
    enum: ['reply', 'replyAll', 'forward'],
    wdRequired: true,
    description: 'Either reply, replyAll or forward'
};

const ReferenceWithAttachments = {
    type: 'object',
    title: 'ReferenceWithAttachments',
    additionalProperties: false,
    properties: {
        mailbox: referenceMailbox,
        id: referenceMessage,
        action: referenceAction,
        attachments: {
            anyOf: [
                { type: 'boolean', wdType: 'boolean', wdEmpty: true },
                {
                    type: 'array',
                    items: {
                        type: 'string',
                        pattern: '^ATT\\d+$',
                        wdUppercase: true
                    }
                }
            ],
            description:
                "If true, then includes all attachments from the original message. If it is an array of attachment ID's includes attachments from the list"
        }
    },
    required: ['mailbox', 'id', 'action']
};

const ReferenceWithoutAttachments = {
    type: 'object',
    title: 'Reference',
    additionalProperties: false,
    properties: {
        mailbox: referenceMailbox,
        id: referenceMessage,
        action: referenceAction
    },
    required: ['mailbox', 'id', 'action']
};

const Bimi = {
    type: 'object',
    title: 'Bimi',
    additionalProperties: false,
    properties: {
        domain: {
            type: 'string',
            wdValidator: 'domain',
            wdRequired: true,
            description: 'Domain name for the BIMI record. It does not have to be the same as the From address.'
        },
        selector: { type: 'string', maxLength: 255, minLength: 1, wdEmpty: true, description: 'Optional BIMI selector' }
    },
    required: ['domain']
};

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
