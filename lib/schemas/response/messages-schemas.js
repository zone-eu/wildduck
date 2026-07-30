'use strict';

const Rcpt = {
    type: 'object',
    title: 'Rcpt',
    additionalProperties: true,
    properties: {
        value: { type: 'string', description: 'RCPT TO address as provided by SMTP client' },
        formatted: { type: 'string', description: 'Normalized RCPT address' }
    }
};

const MsgTls = {
    type: 'object',
    title: 'Tls',
    additionalProperties: true,
    description: 'TLS information',
    properties: {
        name: { type: 'string', description: 'Cipher name, eg "ECDHE-RSA-AES128-GCM-SHA256"' },
        version: { type: 'string', description: 'TLS version, eg "TLSv1/SSLv3"' }
    }
};

const MsgDmarc = {
    type: 'object',
    title: 'Dmarc',
    additionalProperties: true,
    description: 'Verified DMARC domain and applied policy',
    properties: {
        domain: { description: 'Domain name of verified DMARC or false if no DMARC match was found' },
        policy: { type: 'string', description: 'Applied DMARC policy' }
    }
};

const MsgVerificationResults = {
    type: 'object',
    title: 'VerificationResults',
    additionalProperties: true,
    description:
        'Security verification info if message was received from MX. If this property is missing then do not automatically assume invalid TLS, SPF, DKIM or DMARC.',
    properties: {
        tls: { description: 'TLS information. Value is false if TLS was not used' },
        spf: { description: 'Domain name (either MFROM or HELO) of verified SPF or false if no SPF match was found' },
        dkim: { description: 'Domain name of verified DKIM signature or false if no valid signature was found' },
        dmarc: MsgDmarc
    }
};

const MsgEnvelope = {
    type: 'object',
    title: 'Envelope',
    additionalProperties: true,
    description: 'SMTP envelope (if available)',
    properties: {
        from: { type: 'string', description: 'Address from MAIL FROM' },
        rcpt: { type: 'array', items: Rcpt, description: 'Array of addresses from RCPT TO (should have just one normally)' }
    }
};

module.exports = {
    MsgDmarc,
    MsgEnvelope,
    MsgTls,
    MsgVerificationResults
};
