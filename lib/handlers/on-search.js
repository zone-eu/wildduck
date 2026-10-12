'use strict';

const db = require('../db');
const tools = require('../tools');
const consts = require('../consts');
const { getLabelMaps } = require('../label-handler');

// a query that can never match, used where a search key excludes every message
const MATCH_NOTHING = { _id: -1 };

/**
 * Builds the query for a HEADER search key.
 *
 * RFC 3501 6.4.4 allows any field-name, and a zero length string is an existence test for the
 * header. Only the names in consts.INDEXED_HEADERS are copied into the indexed `headers` array,
 * anything else is read from the parsed MIME header, which has no index but gives the right answer.
 */
function buildHeaderQuery(term, ne) {
    let valueMatch = term.value
        ? {
              $regex: tools.escapeRegexStr(Buffer.from(term.value, 'binary').toString()),
              $options: 'i'
          }
        : false;

    if (consts.INDEXED_HEADERS.includes(term.header)) {
        if (!valueMatch) {
            return { 'headers.key': !ne ? term.header : { $ne: term.header } };
        }

        // NOT must also match messages that have no such header at all, so the whole $elemMatch is
        // negated rather than the value inside it
        let elemMatch = { $elemMatch: { key: term.header, value: valueMatch } };
        return { headers: !ne ? elemMatch : { $not: elemMatch } };
    }

    // a "." would address a nested field and a "$" an operator, so such a field-name can not be
    // looked up this way. Both are legal in RFC 5322 but do not occur in practice
    if (/[.$]/.test(term.header)) {
        return MATCH_NOTHING;
    }

    let headerPath = `mimeTree.parsedHeader.${term.header}`;

    if (!valueMatch) {
        return { [headerPath]: { $exists: !ne } };
    }

    return { [headerPath]: !ne ? valueMatch : { $not: valueMatch } };
}

const SENT_DATE_OPERATORS = {
    '<': '$lt',
    '<=': '$lte',
    '>': '$gt',
    '>=': '$gte'
};

/**
 * Builds the query for a SENTBEFORE, SENTON or SENTSINCE search key.
 *
 * RFC 3501 6.4.4 compares the Date header "disregarding time and timezone", which is the calendar
 * date the sender wrote. hdate only holds the instant, so hdateDay carries that date. Messages
 * stored before hdateDay existed fall back to the instant, which is off by a day for a sender who
 * is not in UTC.
 */
function buildSentDateQuery(term, ne) {
    let day = new Date(term.value + ' GMT');
    let op = SENT_DATE_OPERATORS[term.operator];

    // without an operator the key is SENTON, which matches the one calendar day
    let dayEntry = op ? { [op]: day } : day;
    let legacyEntry = op ? { [op]: day } : { $gte: day, $lt: new Date(day.getTime() + 24 * 3600 * 1000) };

    let entry = {
        $or: [{ hdateDay: dayEntry }, { hdateDay: { $exists: false }, hdate: legacyEntry }]
    };

    return !ne ? entry : { $nor: [entry] };
}

/**
 * Returns an array of matching UID values
 */
module.exports = server => (mailbox, options, session, callback) => {
    search(server, mailbox, options, session).then(result => callback(null, result), callback);
};

// Resolves with { uidList, highestModseq } or a response code
async function search(server, mailbox, options, session) {
    let mailboxData = await db.database.collection('mailboxes').findOne(
        {
            _id: mailbox
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        }
    );

    if (!mailboxData) {
        return 'NONEXISTENT';
    }

    const hasLabelQuery = nodes =>
        [].concat(nodes || []).some(term => {
            if (term.key === 'flag') {
                return /^\$wdlabel\$[a-f0-9]{24}$/i.test(term.value);
            }
            if (term.key === 'not' || term.key === 'or') {
                return hasLabelQuery(term.value);
            }
            return false;
        });
    let labelMaps = { records: [] };
    if (hasLabelQuery(options.query)) {
        labelMaps = await getLabelMaps(db.database, mailboxData.user);
    }
    const labelsById = new Map(labelMaps.records.map(record => [record._id.toString(), record]));

    // prepare query

    let query = {
        mailbox: mailboxData._id
    };

    // $text is only allowed in the root of a MongoDB query, so a text term that sits under NOT
    // or OR is resolved with a separate query and substituted as a uid list
    const textSearches = [];
    const $and = [];

    let returned = false;
    let walkQuery = (parent, ne, node) => {
        if (returned) {
            return;
        }
        node.forEach(term => {
            switch (term.key) {
                case 'all':
                    if (ne) {
                        parent.push(MATCH_NOTHING);
                    }
                    break;

                case 'not':
                    walkQuery(parent, !ne, [].concat(term.value || []));
                    break;

                case 'or': {
                    let $or = [];

                    [].concat(term.value || []).forEach(entry => {
                        walkQuery($or, false, [].concat(entry || []));
                    });

                    if ($or.length) {
                        parent.push({
                            $or
                        });
                    }

                    break;
                }

                case 'text': // search over entire email
                case 'body': // search over email body
                    if (!term.value) {
                        parent.push(MATCH_NOTHING);
                        break;
                    }

                    if (!ne && parent === $and && !query.$text) {
                        // a plain text term can go straight into the root of the query
                        query.user = session.user.id;
                        query.searchable = true;
                        query.$text = {
                            $search: term.value
                        };
                        break;
                    }

                    // the placeholder is filled in once the matching uids are known
                    {
                        const placeholder = {};
                        textSearches.push({ placeholder, value: term.value, ne });
                        parent.push(placeholder);
                    }
                    break;

                case 'modseq':
                    parent.push({
                        modseq: {
                            [!ne ? '$gte' : '$lt']: term.value
                        }
                    });
                    break;

                case 'uid':
                    if (Array.isArray(term.value)) {
                        if (!term.value.length) {
                            // trying to find a message that does not exist
                            returned = true;
                            return;
                        }
                        if (term.value.length !== session.selected.uidList.length) {
                            // not 1:*
                            parent.push({
                                uid: tools.checkRangeQuery(term.value, ne, term.value?.isContiguous)
                            });
                        } else if (ne) {
                            parent.push({
                                // should not match anything
                                _id: -1
                            });
                        }
                    } else {
                        parent.push({
                            uid: {
                                [!ne ? '$eq' : '$ne']: term.value
                            }
                        });
                    }
                    break;

                case 'flag':
                    {
                        switch (term.value) {
                            case '\\Seen':
                            case '\\Deleted':
                                // message object has "unseen" and "undeleted" properties
                                if (term.exists) {
                                    parent.push({
                                        ['un' + term.value.toLowerCase().substr(1)]: ne
                                    });
                                } else {
                                    parent.push({
                                        ['un' + term.value.toLowerCase().substr(1)]: !ne
                                    });
                                }
                                break;
                            case '\\Flagged':
                            case '\\Draft':
                                if (term.exists) {
                                    parent.push({
                                        [term.value.toLowerCase().substr(1)]: !ne
                                    });
                                } else {
                                    parent.push({
                                        [term.value.toLowerCase().substr(1)]: ne
                                    });
                                }
                                break;
                            default: {
                                const match = /^\$wdlabel\$([a-f0-9]{24})$/i.exec(term.value);
                                const label = match && labelsById.get(match[1].toLowerCase());
                                const shouldExist = term.exists !== ne;
                                if (label && shouldExist) {
                                    parent.push({
                                        $or: [{ labels: label._id }, { flags: term.value }]
                                    });
                                } else if (label) {
                                    parent.push({
                                        $and: [{ labels: { $ne: label._id } }, { flags: { $ne: term.value } }]
                                    });
                                } else {
                                    parent.push({
                                        flags: {
                                            [shouldExist ? '$eq' : '$ne']: term.value
                                        }
                                    });
                                }
                            }
                        }
                    }
                    break;

                case 'header':
                    parent.push(buildHeaderQuery(term, ne));
                    break;

                case 'internaldate':
                    {
                        let op = false;
                        let value = term.value instanceof Date ? term.value : new Date(term.value + ' GMT');
                        switch (term.operator) {
                            case '<':
                                op = '$lt';
                                break;
                            case '<=':
                                op = '$lte';
                                break;
                            case '>':
                                op = '$gt';
                                break;
                            case '>=':
                                op = '$gte';
                                break;
                        }
                        let entry = !op
                            ? {
                                  $gte: value,
                                  $lt: new Date(value.getTime() + 24 * 3600 * 1000)
                              }
                            : {
                                  [op]: value
                              };

                        entry = {
                            idate: !ne
                                ? entry
                                : {
                                      $not: entry
                                  }
                        };

                        parent.push(entry);
                    }
                    break;

                case 'date':
                    parent.push(buildSentDateQuery(term, ne));
                    break;

                case 'size':
                    {
                        let op = '$eq';
                        let value = Number(term.value) || 0;
                        switch (term.operator) {
                            case '<':
                                op = '$lt';
                                break;
                            case '<=':
                                op = '$lte';
                                break;
                            case '>':
                                op = '$gt';
                                break;
                            case '>=':
                                op = '$gte';
                                break;
                        }

                        let entry = {
                            [op]: value
                        };

                        entry = {
                            size: !ne
                                ? entry
                                : {
                                      $not: entry
                                  }
                        };

                        parent.push(entry);
                    }
                    break;
            }
        });
    };

    walkQuery($and, false, options.query);
    if (returned) {
        return {
            uidList: [],
            highestModseq: 0
        };
    }

    if ($and.length) {
        query.$and = $and;
    }

    // RFC 3501 6.4.4 requires NOT and OR to work for TEXT and BODY as well
    const resolveTextSearches = async () => {
        const values = [...new Set(textSearches.map(entry => entry.value))];

        const uidsByValue = new Map(
            await Promise.all(
                values.map(async value => {
                    const messages = await db.database
                        .collection('messages')
                        .find({
                            user: session.user.id,
                            mailbox: mailboxData._id,
                            searchable: true,
                            $text: {
                                $search: value
                            }
                        })
                        .project({ uid: true, _id: false })
                        .withReadPreference('secondaryPreferred')
                        .maxTimeMS(consts.DB_MAX_TIME_MESSAGES)
                        .toArray();

                    return [value, messages.map(message => message.uid).sort((a, b) => a - b)];
                })
            )
        );

        for (const entry of textSearches) {
            entry.placeholder.uid = tools.checkRangeQuery(uidsByValue.get(entry.value), entry.ne);
        }
    };

    let highestModseq = 0;
    let uidList = [];

    try {
        await resolveTextSearches();

        server.logger.info(
            {
                tnx: 'search',
                cid: session.id
            },
            '[%s] SEARCH %s',
            session.id,
            JSON.stringify(query)
        );

        let cursor = db.database
            .collection('messages')
            .find(query)
            .project({
                uid: true,
                modseq: true
            })
            .withReadPreference('secondaryPreferred')
            .maxTimeMS(consts.DB_MAX_TIME_MESSAGES);

        for await (let message of cursor) {
            if (highestModseq < message.modseq) {
                highestModseq = message.modseq;
            }

            uidList.push(message.uid);
        }
    } catch (err) {
        server.logger.error(
            {
                tnx: 'search',
                cid: session.id
            },
            '[%s] SEARCHFAIL %s error="%s"',
            session.id,
            JSON.stringify(query),
            err.message
        );
        if (typeof server.loggelf === 'function') {
            server.loggelf({
                short_message: '[SEARCHFAIL] ' + (err && err.message ? err.message : 'Search failed'),
                _stack: err && err.stack,
                _error: err && err.message,
                _code: err && err.code,
                _tnx: 'search',
                _sess: session.id,
                _user: session.user && session.user.id,
                _mailbox: mailbox,
                _mailbox_path: mailboxData && mailboxData.path,
                _query: JSON.stringify(query)
            });
        }
        throw new Error('Can not make requested search query');
    }

    return {
        uidList,
        highestModseq
    };
}
