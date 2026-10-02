/* eslint no-console: 0, new-cap: 0 */

'use strict';

const imapFormalSyntax = require('./imap-formal-syntax');

/**
 * Compiles an input object into
 */
module.exports = function (response, asArray, isLogging) {
    let respParts = [];
    let resp = (response.tag || '') + (response.command ? ' ' + response.command : '');
    let val;
    let lastType;
    // RFC 3501 9 only allows DQUOTE and backslash to be escaped inside a quoted string, so a value
    // that holds CR or LF has to go out as a literal instead
    let pushString = function (value) {
        if (imapFormalSyntax.needsLiteral(value)) {
            resp += '{' + Buffer.byteLength(value, 'binary') + '}\r\n';
            respParts.push(resp);
            resp = value;
            lastType = 'LITERAL';
            return;
        }
        resp += imapFormalSyntax.quote(value);
    };

    let walk = function (node, options) {
        options = options || {};

        if (lastType === 'LITERAL' || (!['(', '<', '['].includes(resp.substr(-1)) && resp.length)) {
            if (options.subArray) {
                // ignore separator
            } else {
                resp += ' ';
            }
        }

        if (node && node.buffer && !Buffer.isBuffer(node)) {
            // mongodb binary
            node = node.buffer;
        }

        if (Array.isArray(node)) {
            lastType = 'LIST';
            resp += '(';

            // check if we need to skip separator WS between two arrays
            let subArray = node.length > 1 && Array.isArray(node[0]);

            node.forEach(child => {
                if (subArray && !Array.isArray(child)) {
                    subArray = false;
                }
                walk(child, { subArray });
            });
            resp += ')';
            return;
        }

        if (!node && typeof node !== 'string' && typeof node !== 'number' && !Buffer.isBuffer(node)) {
            resp += 'NIL';
            return;
        }

        if (typeof node === 'string' || Buffer.isBuffer(node)) {
            if (isLogging && node.length > 20) {
                resp += '"(* ' + node.length + 'B string *)"';
            } else {
                pushString(node.toString('binary'));
            }
            return;
        }

        if (typeof node === 'number') {
            resp += Math.round(node) || 0; // Only integers allowed
            return;
        }

        lastType = node.type;

        if (isLogging && node.sensitive) {
            resp += '"(* value hidden *)"';
            return;
        }

        switch (node.type.toUpperCase()) {
            case 'LITERAL':
                if (isLogging) {
                    resp += '"(* ' + ((node.value && node.value.length) || 0) + 'B literal *)"';
                } else {
                    if (!node.value) {
                        resp += '{0}\r\n';
                    } else {
                        resp += '{' + Math.max(node.value.length, 0) + '}\r\n';
                    }
                    respParts.push(resp);
                    resp = (node.value || '').toString('binary');
                }
                break;

            case 'STRING':
                if (isLogging && node.value && node.value.length > 20) {
                    resp += '"(* ' + node.value.length + 'B string *)"';
                } else {
                    pushString((node.value || '').toString('binary'));
                }
                break;
            case 'TEXT':
            case 'SEQUENCE':
                resp += (node.value || '').toString('binary');
                break;

            case 'NUMBER':
                resp += node.value || 0;
                break;

            case 'ATOM':
            case 'SECTION':
                val = (node.value || '').toString('binary');

                if (imapFormalSyntax.needsQuoting(val)) {
                    val = imapFormalSyntax.quote(val);
                }

                resp += val;

                if (node.section) {
                    resp += '[';
                    node.section.forEach(child => walk(child));
                    resp += ']';
                }
                if (node.partial) {
                    resp += '<' + node.partial.join('.') + '>';
                }
                break;
        }
    };

    [].concat(response.attributes || []).forEach(child => walk(child));

    if (resp.length) {
        respParts.push(resp);
    }

    return asArray ? respParts : respParts.join('');
};
