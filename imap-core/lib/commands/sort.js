'use strict';

const imapHandler = require('../handler/imap-handler');
const { parseQueryTerms } = require('./search');
const { SORT_KEYS } = require('../sort-search-results');

module.exports = {
    state: 'Selected',
    schema: false, // recursive search criteria

    handler(command, callback) {
        // Reuse SEARCH backend implementation
        if (typeof this._server.onSearch !== 'function') {
            return callback(null, {
                response: 'NO',
                message: command.command + ' not implemented'
            });
        }

        const isUid = (command.command || '').toString().toUpperCase() === 'UID SORT';

        let parsed;
        try {
            parsed = parseSortCommand(command.attributes, this.selected.uidList);
        } catch (E) {
            return callback(E);
        }

        if (!isSupportedCharset(parsed.charset)) {
            return callback(null, {
                response: 'NO',
                code: 'BADCHARSET',
                message: `Unsupported charset ${parsed.charset}`
            });
        }

        const logdata = {
            short_message: '[SORT]',
            _mail_action: 'sort',
            _user: this.session.user.id.toString(),
            _mailbox: this.selected.mailbox,
            _sess: this.id,
            _charset: parsed.charset,
            _sort: JSON.stringify(parsed.sort),
            _query: JSON.stringify(parsed.query),
            _terms: JSON.stringify(parsed.terms)
        };

        this._server.onSearch(
            this.selected.mailbox,
            {
                query: parsed.query,
                terms: parsed.terms,
                isUid,
                sort: parsed.sort,
                charset: parsed.charset
            },
            this.session,
            (err, results) => {
                if (err) {
                    logdata._error = err.message;
                    logdata._code = err.code;
                    logdata._response = err.response;
                    this._server.loggelf(logdata);
                    return callback(null, {
                        response: 'NO',
                        code: 'TEMPFAIL'
                    });
                }

                let matches = results.uidList;
                if (typeof matches === 'string') {
                    return callback(null, {
                        response: 'NO',
                        code: matches.toUpperCase()
                    });
                }

                let response = {
                    tag: '*',
                    command: 'SORT',
                    attributes: []
                };

                if (Array.isArray(matches) && matches.length) {
                    if (isUid) {
                        response.attributes.push({
                            type: 'TEXT',
                            value: matches.join(' ')
                        });
                    } else {
                        let uidList = this.selected.uidList || [];
                        let uidIndex = new Map();
                        let seqList = [];

                        for (let i = 0; i < uidList.length; i++) {
                            uidIndex.set(uidList[i], i + 1);
                        }

                        for (let i = 0; i < matches.length; i++) {
                            let seq = uidIndex.get(matches[i]);
                            if (seq) {
                                seqList.push(seq);
                            }
                        }

                        if (seqList.length) {
                            response.attributes.push({
                                type: 'TEXT',
                                value: seqList.join(' ')
                            });
                        }
                    }
                }

                this.send(imapHandler.compiler(response));

                return callback(null, {
                    response: 'OK',
                    message: 'SORT completed'
                });
            }
        );
    },

    parseSortCommand
};

function parseSortCommand(attributes, uidList) {
    attributes = [].concat(attributes || []);

    if (attributes.length < 3) {
        throw new Error('Invalid arguments for SORT');
    }

    let sort = parseSortCriteria(attributes[0]);

    let charset = ((attributes[1] && attributes[1].value) || '').toString().trim();
    if (!charset) {
        throw new Error('Invalid charset argument for SORT');
    }

    let terms = [];
    flattenAttributeValues(attributes.slice(2), terms);
    if (!terms.length) {
        throw new Error('Missing search criteria for SORT');
    }

    let parsed = parseQueryTerms(terms, uidList);

    return {
        sort,
        charset,
        query: parsed.query,
        terms: parsed.terms
    };
}

function parseSortCriteria(criteria) {
    let tokens = [];
    flattenAttributeValues(criteria, tokens);
    tokens = tokens.map(value => (value || '').toString().trim().toUpperCase()).filter(value => value);

    if (!tokens.length) {
        throw new Error('Invalid sort criteria for SORT');
    }

    let reverse = false;
    let result = [];

    for (let i = 0; i < tokens.length; i++) {
        let token = tokens[i];

        if (token === 'REVERSE') {
            if (reverse) {
                throw new Error('Invalid sort criteria for SORT');
            }
            reverse = true;
            continue;
        }

        let key = token.toLowerCase();
        if (!SORT_KEYS.has(key)) {
            throw new Error('Invalid sort criterion ' + token + ' for SORT');
        }

        result.push({
            key,
            reverse
        });
        reverse = false;
    }

    if (reverse || !result.length) {
        throw new Error('Invalid sort criteria for SORT');
    }

    return result;
}

function flattenAttributeValues(elements, terms) {
    elements = [].concat(elements || []);

    elements.forEach(element => {
        if (Array.isArray(element)) {
            return flattenAttributeValues(element, terms);
        }

        if (element?.value) {
            terms.push(element.value);
            return;
        }

        terms.push(element);
    });
}

function isSupportedCharset(charset) {
    charset = (charset || '').toString().trim().toUpperCase();
    return ['UTF-8', 'UTF8', 'US-ASCII', 'ASCII'].includes(charset);
}
