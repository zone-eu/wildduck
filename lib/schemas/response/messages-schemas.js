'use strict';
const Joi = require('joi');
const { booleanSchema } = require('../../schemas');

const Rcpt = Joi.object({
    value: Joi.string().required().description('RCPT TO address as provided by SMTP client'),
    formatted: Joi.string().required().description('Normalized RCPT address')
}).$_setFlag('objectName', 'Rcpt');

const MsgTls = Joi.object({
    name: Joi.string().required().description('Cipher name, eg "ECDHE-RSA-AES128-GCM-SHA256"'),
    version: Joi.string().required().description('TLS version, eg "TLSv1/SSLv3"')
})
    .$_setFlag('objectName', 'Tls')
    .description('TLS information');

const MsgDmarc = Joi.object({
    domain: Joi.alternatives()
        .try(Joi.string(), booleanSchema)
        .required()
        .description('Domain name of verified DMARC or false if no DMARC match was found'),
    policy: Joi.string().valid('none', 'quarantine', 'reject').required().description('Applied DMARC policy')
})
    .$_setFlag('objectName', 'Dmarc')
    .description('Verified DMARC domain and applied policy');

const MsgVerificationResults = Joi.object({
    tls: Joi.alternatives()
        .try(MsgTls, booleanSchema)
        .description('TLS information. Value is false if TLS was not used'),
    spf: Joi.alternatives()
        .try(Joi.string(), booleanSchema)
        .description('Domain name (either MFROM or HELO) of verified SPF or false if no SPF match was found'),
    dkim: Joi.alternatives()
        .try(Joi.string(), booleanSchema)
        .description('Domain name of verified DKIM signature or false if no valid signature was found'),
    dmarc: MsgDmarc
}).description(
    'Security verification info if message was received from MX. If this property is missing then do not automatically assume invalid TLS, SPF, DKIM or DMARC.'
)
    .$_setFlag('objectName', 'VerificationResults');

const MsgEnvelope = Joi.object({
    from: Joi.string().required().description('Address from MAIL FROM'),
    rcpt: Joi.array().items(Rcpt).description('Array of addresses from RCPT TO (should have just one normally)')
})
    .description('SMTP envelope (if available)')
    .$_setFlag('objectName', 'Envelope');

module.exports = {
    MsgDmarc,
    MsgEnvelope,
    MsgTls,
    MsgVerificationResults
};
