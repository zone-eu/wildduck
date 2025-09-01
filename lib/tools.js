/* eslint no-control-regex: 0 */
'use strict';

const os = require('os');
const punycode = require('punycode.js');
const libmime = require('libmime');
const consts = require('./consts');
const errors = require('./errors');
const fs = require('fs');
const he = require('he');
const pathlib = require('path');
const crypto = require('crypto');
const urllib = require('url');
const net = require('net');
const ipaddr = require('ipaddr.js');
const ObjectId = require('mongodb').ObjectId;
const log = require('npmlog');
const addressparser = require('nodemailer/lib/addressparser');

let templates = false;

function checkRangeQuery(uids, ne) {
    // check if uids is a straight continuous array and if such then return a range query,
    // otherwise return a $in query

    if (uids.length === 1) {
        return {
            [!ne ? '$eq' : '$ne']: uids[0]
        };
    }

    for (let i = 1, len = uids.length; i < len; i++) {
        if (uids[i] !== uids[i - 1] + 1) {
            // TODO: group into AND conditions, otherwise expands too much!
            return {
                [!ne ? '$in' : '$nin']: uids
            };
        }
    }

    if (!ne) {
        return {
            $gte: uids[0],
            $lte: uids[uids.length - 1]
        };
    } else {
        return {
            $not: {
                $gte: uids[0],
                $lte: uids[uids.length - 1]
            }
        };
    }
}

function normalizeDomain(domain) {
    domain = (domain || '').toLowerCase().trim();
    try {
        if (/^xn--/.test(domain)) {
            domain = punycode.toUnicode(domain).normalize('NFC').toLowerCase().trim();
        }
    } catch (E) {
        // ignore
    }

    return domain;
}

function normalizeAddress(address, withNames, options) {
    if (typeof address === 'string') {
        address = {
            address
        };
    }
    if (!address || !address.address) {
        return '';
    }

    options = options || {};

    let removeLabel = typeof options.removeLabel === 'boolean' ? options.removeLabel : false;
    let removeDots = typeof options.removeDots === 'boolean' ? options.removeDots : false;

    let user = address.address.substr(0, address.address.lastIndexOf('@')).normalize('NFC').toLowerCase().trim();

    if (removeLabel) {
        user = user.replace(/\+[^@]*$/, '');
    }

    if (removeDots) {
        user = user.replace(/\./g, '');
    }

    let domain = normalizeDomain(address.address.substr(address.address.lastIndexOf('@') + 1));

    let addr = user + '@' + domain;

    if (withNames) {
        return {
            name: address.name || '',
            address: addr
        };
    }

    return addr;
}

/**
 * Generate a list of possible wildcard addresses by generating all possible
 * substrings of the username email address part.
 *
 * @param {String} username - The username part of the email address.
 * @param {String} domain - The domain part of the email address.
 * @return {Array} The list of all possible username wildcard addresses,
 *   that would match this email address (as given by the params).
 */
function getWildcardAddresses(username, domain) {
    if (typeof username !== 'string' || typeof domain !== 'string') {
        return [];
    }

    let result = ['*@' + domain];
    // <= generates the 'simple' wildcard (a la '*@') address.
    for (let i = 1; i < Math.min(username.length, consts.MAX_ALLOWED_WILDCARD_LENGTH) + 1; i++) {
        result.unshift('*' + username.substr(-i) + '@' + domain);
        result.unshift(username.substr(0, i) + '*@' + domain);
    }

    return result;
}

// returns a redis config object with a retry strategy
function redisConfig(defaultConfig) {
    return defaultConfig;
}

function decodeAddresses(addresses) {
    addresses.forEach(address => {
        address.name = (address.name || '').toString();
        if (address.name) {
            try {
                address.name = libmime.decodeWords(address.name);
            } catch (E) {
                //ignore, keep as is
            }
        }
        if (/@xn--/.test(address.address)) {
            address.address =
                address.address.substr(0, address.address.lastIndexOf('@') + 1) +
                punycode.toUnicode(address.address.substr(address.address.lastIndexOf('@') + 1));
        }
        if (address.group) {
            decodeAddresses(address.group);
        }
    });
}

function flatAddresses(addresses) {
    let list = [];
    let walk = address => {
        if (address.address) {
            list.push(address);
        } else if (address.group) {
            address.group.forEach(walk);
        }
    };
    walk(addresses);
    return list;
}

async function getMailboxCounter(db, mailbox, type) {
    const cacheKey = `${type || 'total'}:${mailbox.toString()}`;

    try {
        // Check cache for pre-calculated counter value
        let sum = await db.redis.get(cacheKey);
        if (sum !== null && !isNaN(sum) && Number(sum) >= 0) {
            return Number(sum);
        }

        // calculate sum
        let query = { mailbox };
        if (type) {
            query[type] = true;
        }

        sum = await db.database.collection('messages').countDocuments(query);

        // Cache calculated sum in redis

        await db.redis.multi().set(cacheKey, sum).expire(cacheKey, consts.MAILBOX_COUNTER_TTL).exec();

        return sum;
    } catch (err) {
        errors.notify(err);
        throw err;
    }
}

function renderEmailTemplate(tags, template) {
    let result = JSON.parse(JSON.stringify(template));

    let specialTags = {
        TIMESTAMP: Date.now(),
        HOSTNAME: tags.DOMAIN || os.hostname()
    };

    let walk = (node, nodeKey) => {
        if (!node) {
            return;
        }

        Object.keys(node || {}).forEach(key => {
            if (!node[key] || ['content'].includes(key)) {
                return;
            }

            if (Array.isArray(node[key])) {
                return node[key].forEach(child => walk(child, nodeKey));
            }

            if (typeof node[key] === 'object') {
                return walk(node[key], key);
            }

            if (typeof node[key] === 'string') {
                let isHTML = /html/i.test(key);
                node[key] = node[key].replace(/\[([^\]]+)\]/g, (match, tag) => {
                    if (tag in tags) {
                        return isHTML ? he.encode(tags[tag]) : tags[tag];
                    } else if (tag in specialTags) {
                        return isHTML ? he.encode((specialTags[tag] || '').toString()) : specialTags[tag];
                    }
                    return match;
                });
                return;
            }
        });
    };

    walk(result, false);

    return result;
}

async function getEmailTemplates(tags) {
    if (templates) {
        return templates.map(template => renderEmailTemplate(tags, template));
    }
    let templateFolder = pathlib.join(__dirname, '..', 'emails');
    let files = await fs.promises.readdir(templateFolder);

    files = files.sort((a, b) => a.localeCompare(b));

    let filesMap = new Map();

    for (let file of files) {
        let fParts = pathlib.parse(file);
        try {
            let value = await fs.promises.readFile(pathlib.join(templateFolder, file));

            let ext = fParts.ext.toLowerCase();
            let name = fParts.name.toLowerCase();
            if (name.indexOf('.') >= 0) {
                name = name.substr(0, name.indexOf('.'));
            }

            let type = false;
            switch (ext) {
                case '.json': {
                    try {
                        value = JSON.parse(value.toString('utf-8'));
                        type = 'message';
                    } catch (E) {
                        //ignore?
                    }
                    break;
                }
                case '.html':
                case '.htm':
                    value = value.toString('utf-8');
                    type = 'html';
                    break;
                case '.text':
                case '.txt':
                    value = value.toString('utf-8');
                    type = 'text';
                    break;
                default: {
                    if (name.length < fParts.name.length) {
                        type = 'attachment';
                        value = {
                            filename: fParts.base.substr(name.length + 1),
                            content: value.toString('base64'),
                            encoding: 'base64'
                        };
                    }
                }
            }

            if (type) {
                if (!filesMap.has(name)) {
                    filesMap.set(name, {});
                }
                if (type === 'attachment') {
                    if (!filesMap.get(name).attachments) {
                        filesMap.get(name).attachments = [value];
                    } else {
                        filesMap.get(name).attachments.push(value);
                    }
                } else {
                    filesMap.get(name)[type] = value;
                }
            }
        } catch (err) {
            // ignore
        }
    }

    let newTemplates = Array.from(filesMap)
        .map(entry => {
            let name = escapeRegexStr(entry[0]);
            entry = entry[1];
            if (!entry.message || entry.disabled) {
                return false;
            }

            if (entry.html) {
                entry.message.html = entry.html;
            }

            if (entry.text) {
                entry.message.text = entry.text;
            }

            if (entry.attachments) {
                entry.message.attachments = [].concat(entry.message.attachments || []).concat(entry.attachments);

                if (entry.message.html) {
                    entry.message.attachments.forEach(attachment => {
                        if (entry.message.html.indexOf(attachment.filename) >= 0) {
                            // replace html image link with a link to the attachment
                            let fname = escapeRegexStr(attachment.filename);
                            entry.message.html = entry.message.html.replace(
                                new RegExp('(["\'])(?:.\\/)?(?:' + name + '.)?' + fname + '(?=["\'])', 'g'),
                                (m, p) => {
                                    attachment.cid = attachment.cid || crypto.randomBytes(8).toString('hex') + '-[TIMESTAMP]@[DOMAIN]';
                                    return p + 'cid:' + attachment.cid;
                                }
                            );
                        }
                    });
                }
            }

            if (entry.text) {
                entry.message.text = entry.text;
            }

            return entry.message;
        })
        .filter(entry => entry && !entry.disabled);

    templates = newTemplates;
    return templates.map(template => renderEmailTemplate(tags, template));
}

function escapeRegexStr(string) {
    let specials = ['-', '[', ']', '/', '{', '}', '(', ')', '*', '+', '?', '.', '\\', '^', '$', '|'];
    return string.replace(RegExp('[' + specials.join('\\') + ']', 'g'), '\\$&');
}

function getRelayData(url) {
    let urlparts = urllib.parse(url);
    let targetMx = {
        host: urlparts.hostname,
        port: urlparts.port || 25,
        auth: urlparts.auth
            ? [urlparts.auth].map(auth => {
                  let parts = auth.split(':');
                  return {
                      user: decodeURIComponent(parts[0] || ''),
                      pass: decodeURIComponent(parts[1] || '')
                  };
              })[0]
            : false,
        secure: urlparts.protocol === 'smtps:',
        A: [].concat(net.isIPv4(urlparts.hostname) ? urlparts.hostname : []),
        AAAA: [].concat(net.isIPv6(urlparts.hostname) ? urlparts.hostname : [])
    };
    let data = {
        mx: [
            {
                priority: 0,
                mx: true,
                exchange: targetMx.host,
                A: targetMx.A,
                AAAA: targetMx.AAAA
            }
        ],
        mxPort: targetMx.port,
        mxAuth: targetMx.auth,
        mxSecure: targetMx.secure,
        url
    };

    return data;
}

function isId(value) {
    if (!value) {
        // obviously
        return false;
    }

    if (typeof value === 'object' && ObjectId.isValid(value)) {
        return true;
    }

    if (typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value) && ObjectId.isValid(value)) {
        return true;
    }

    return false;
}

function uview(address) {
    if (!address) {
        return '';
    }

    if (typeof address !== 'string') {
        address = address.toString() || '';
    }

    let atPos = address.indexOf('@');
    if (atPos < 0) {
        return address.replace(/\./g, '').toLowerCase();
    } else {
        return (address.substr(0, atPos).replace(/\./g, '') + address.substr(atPos)).toLowerCase();
    }
}

function validationErrors(validationResult) {
    const errors = {};
    if (validationResult.error && validationResult.error.details) {
        validationResult.error.details.forEach(detail => {
            if (!errors[detail.path]) {
                errors[detail.path] = detail.message;
            }
        });
    }
    return errors;
}

function checkSocket(socket) {
    if (!socket || socket.destroyed || socket.readyState !== 'open') {
        throw new Error('Socket not open');
    }
}

function getHostname(req) {
    let host =
        []
            .concat(req.headers.host || [])
            .concat(req.authority || [])
            .concat(req.ip || [])
            .shift() || '';
    host = host.split(':').shift();

    if (host) {
        host = normalizeDomain(host);
    }

    return host;
}

function normalizeIp(ip) {
    ip = (ip || '').toString().toLowerCase().trim();

    if (/^[a-f0-9:]+:(\d+\.){3}\d+$/.test(ip)) {
        // remove pseudo IPv6 prefix
        ip = ip.replace(/^[a-f0-9:]+:((\d+\.){3}\d+)$/, '$1');
    }

    if (net.isIPv6(ip)) {
        // use the short version
        return ipaddr.parse(ip).toString();
    }

    return ip;
}

function prepareArmoredPubKey(pubKey) {
    pubKey = (pubKey || '').toString().replace(/\r?\n/g, '\n').trim();
    if (/^-----[^-]+-----\n/.test(pubKey) && !/\n\n/.test(pubKey)) {
        // header is missing, add blank line after first newline
        pubKey = pubKey.replace(/\n/, '\n\n');
    }
    return pubKey;
}

function getPGPUserId(pubKey) {
    let name = '';
    let address = '';

    if (!pubKey || !pubKey.users || !pubKey.users.length) {
        return { name, address };
    }

    let userData = pubKey.users.find(u => u && u.userID && (u.userID.userID || u.userID.name || u.userID.email));
    if (!userData) {
        return { name, address };
    }

    name = userData.userID.name || '';
    address = userData.userID.address || '';

    if (!name || !address) {
        let user = addressparser(userData.userID.userID);
        if (user && user.length) {
            if (!address && user[0].address) {
                address = normalizeAddress(user[0].address);
            }
            if (!name && user[0].name) {
                try {
                    name = libmime.decodeWords(user[0].name || '').trim();
                } catch (E) {
                    // failed to parse value
                    name = user[0].name || '';
                }
            }
        }
    }

    return { name, address };
}

function formatFingerprint(fingerprint) {
    if (typeof fingerprint === 'string') {
        return fingerprint.match(/.{1,2}/g).join(':');
    }

    let out = [];
    for (let nr of fingerprint) {
        out.push((nr < 0x10 ? '0' : '') + nr.toString(16).toLowerCase());
    }
    return out.join(':');
}

function getEnabled2fa(enabled2fa) {
    let list = Array.isArray(enabled2fa) ? enabled2fa : [].concat(enabled2fa ? 'totp' : []);

    if (list.includes('u2f')) {
        let listSet = new Set(list);
        listSet.delete('u2f'); // not supported anymore
        list = Array.from(listSet);
    }

    return list;
}

function roundTime(seconds) {
    let days = Math.floor(seconds / (24 * 3600));
    if (days) {
        return `${days} ${days === 1 ? 'day' : 'days'}`;
    }

    let hours = Math.floor(seconds / 3600);
    if (hours) {
        return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
    }

    let minutes = Math.floor(seconds / 3600);
    if (minutes) {
        return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    }

    return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function parsePemBundle(bundle) {
    bundle = (bundle || '').toString().split(/\r?\n/).join('\x00');
    let matches = bundle.match(/[-]{3,}BEGIN [^-]+[-]{3,}.*?[-]{3,}END [^-]+[-]{3,}/g);
    if (matches) {
        matches = Array.from(matches).map(cert => cert.replace(/\x00/g, '\n') + '\n');
    }
    return matches;
}

function buildCertChain(cert, ca) {
    return [cert]
        .concat(ca || [])
        .flatMap(ca => ca)
        .map(ca => ca.trim() + '\n')
        .filter(ca => ca.trim())
        .join('\n');
}

function parseFilterQueryText(queryText) {
    if (!queryText || typeof queryText !== 'string') {
        return { andTerms: [], orTerms: [] };
    }

    const normalized = queryText.trim();

    const { cleanQuery, phrases: exactPhrases } = extractQuotedPhrases(normalized);

    const orParts = cleanQuery.split(' OR '); // Has to be uppercase

    const orTerms = [];
    const andTerms = [];

    if (orParts.length === 1) {
        const terms = cleanQuery.split(/[,\s]+/).filter(term => term.length > 0);
        andTerms.push(...terms);
    } else {
        for (const part of orParts) {
            const trimmedPart = part.trim();
            if (trimmedPart) {
                orTerms.push(trimmedPart);
            }
        }
    }

    return { andTerms, orTerms, exactPhrases };
}

function filterQueryTermMatches(text, term, exactPhrases = []) {
    const phraseMatch = term.match(/__PHRASE_(\d+)__/);

    if (phraseMatch) {
        const phraseIndex = parseInt(phraseMatch[1], 10);
        const exactPhrase = exactPhrases[phraseIndex];

        if (exactPhrase) {
            return text.includes(exactPhrase.trim());
        }
        return false;
    }

    term = term.toLowerCase();

    if (term.includes(' ') || term.includes(',')) {
        const words = term.split(/[,\s]+/).filter(term => term.length > 0);
        return words.every(word => text.includes(word));
    }

    return text.includes(term);
}

function extractQuotedPhrases(query) {
    const phrases = [];
    let cleanQuery = query;

    const quoteRegex = /"([^"]*)"/g;
    let match;
    let index = 0;

    while ((match = quoteRegex.exec(query)) !== null) {
        const phrase = match[1].trim();
        if (phrase) {
            phrases.push(phrase);
            cleanQuery = cleanQuery.replace(match[0], `__PHRASE_${index}__`);
            index++;
        }
    }

    return { cleanQuery, phrases };
}

module.exports = {
    normalizeAddress,
    normalizeDomain,
    normalizeIp,
    getHostname,
    getWildcardAddresses,
    redisConfig,
    checkRangeQuery,
    decodeAddresses,
    flatAddresses,
    getMailboxCounter,
    getEmailTemplates,
    getRelayData,
    isId,
    uview,
    escapeRegexStr,
    validationErrors,
    checkSocket,
    prepareArmoredPubKey,
    getPGPUserId,
    formatFingerprint,
    getEnabled2fa,
    roundTime,
    parsePemBundle,
    buildCertChain,
    parseFilterQueryText,
    filterQueryTermMatches,
    extractQuotedPhrases,

    formatMetaData: metaData => {
        if (typeof metaData === 'string') {
            try {
                metaData = JSON.parse(metaData);
            } catch (err) {
                // ignore
            }
        }
        return metaData || {};
    },

    responseWrapper(middleware) {
        return async (req, res) => {
            req._localId = crypto.randomBytes(8).toString('hex');
            try {
                await middleware(req, res);
            } catch (err) {
                let data = {
                    error: err.formattedMessage || err.message
                };

                switch (err.code) {
                    case 'ALREADYEXISTS':
                        err.responseCode = err.responseCode || 400;
                        err.code = 'MailboxExistsError';
                        break;
                    case 'NONEXISTENT':
                        err.responseCode = err.responseCode || 404;
                        err.code = 'NoSuchMailbox';
                        break;
                    case 'CANNOT':
                        err.responseCode = err.responseCode || 400;
                        err.code = 'DisallowedMailboxMethod';
                        break;
                }

                if (err.responseCode) {
                    res.status(err.responseCode);
                }

                if (err.code) {
                    data.code = err.code;
                }

                if (err.details && typeof err.details === 'object') {
                    for (let key of Object.keys(err.details)) {
                        if (!data[key]) {
                            data[key] = err.details[key];
                        }
                    }
                }

                log.http(
                    'Error',
                    `${req.method} ${req.url} sess=${(req.params && req.params.sess) || '-'} user=${req.user ? req.user : '-'} error=${JSON.stringify(
                        err.stack
                    )}`
                );

                res.charSet('utf-8');
                res.json(data);
            }
        };
    }
};
