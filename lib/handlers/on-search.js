'use strict';

const db = require('../db');
const tools = require('../tools');
const consts = require('../consts');

/**
 * Returns an array of matching UID values
 */
module.exports = server => (mailbox, options, session, callback) => {
    db.database.collection('mailboxes').findOne(
        {
            _id: mailbox
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        },
        (err, mailboxData) => {
            if (err) {
                return callback(err);
            }
            if (!mailboxData) {
                return callback(null, 'NONEXISTENT');
            }

            // prepare query

            let query = {
                mailbox: mailboxData._id
            };

            let returned = false;
            let walkQuery = (parent, ne, node) => {
                if (returned) {
                    return;
                }
                node.forEach(term => {
                    switch (term.key) {
                        case 'all':
                            if (ne) {
                                parent.push({
                                    // should not match anything
                                    _id: -1
                                });
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
                            if (term.value && !ne) {
                                // fulltext can only be in the root of the query, not in $not, $or expressions
                                // https://docs.mongodb.com/v3.4/tutorial/text-search-in-aggregation/#restrictions
                                query.user = session.user.id;
                                query.searchable = true;
                                query.$text = {
                                    $search: term.value
                                };
                            } else {
                                // can not search by text
                                parent.push({
                                    // should not match anything
                                    _id: -1
                                });
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
                                    return callback(null, {
                                        uidList: [],
                                        highestModseq: 0
                                    });
                                }
                                if (term.value.length !== session.selected.uidList.length) {
                                    // not 1:*
                                    parent.push({
                                        uid: tools.checkRangeQuery(term.value, ne)
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
                                    default:
                                        if (term.exists) {
                                            parent.push({
                                                flags: {
                                                    [!ne ? '$eq' : '$ne']: term.value
                                                }
                                            });
                                        } else {
                                            parent.push({
                                                flags: {
                                                    [!ne ? '$ne' : '$eq']: term.value
                                                }
                                            });
                                        }
                                }
                            }
                            break;

                        case 'header':
                            {
                                let regex = tools.escapeRegexStr(Buffer.from(term.value, 'binary').toString());
                                let entry = term.value
                                    ? {
                                          headers: {
                                              $elemMatch: {
                                                  key: term.header,
                                                  value: !ne
                                                      ? {
                                                            $regex: regex,
                                                            $options: 'i'
                                                        }
                                                      : {
                                                            // not can not have a regex, so try exact match instead even if it fails
                                                            $not: {
                                                                $eq: Buffer.from(term.value, 'binary').toString().toLowerCase().trim()
                                                            }
                                                        }
                                              }
                                          }
                                      }
                                    : {
                                          'headers.key': !ne
                                              ? term.header
                                              : {
                                                    $ne: term.header
                                                }
                                      };
                                parent.push(entry);
                            }
                            break;

                        case 'internaldate':
                            {
                                let op = false;
                                let value = new Date(term.value + ' GMT');
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
                            {
                                let op = false;
                                let value = new Date(term.value + ' GMT');
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
                                    hdate: !ne
                                        ? entry
                                        : {
                                              $not: entry
                                          }
                                };

                                parent.push(entry);
                            }
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

            let $and = [];
            walkQuery($and, false, options.query);
            if (returned) {
                return;
            }

            if ($and.length) {
                query.$and = $and;
            }

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

            let highestModseq = 0;
            let uidList = [];

            let processNext = () => {
                cursor.next((err, message) => {
                    if (err) {
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
                        return callback(new Error('Can not make requested search query'));
                    }
                    if (!message) {
                        return cursor.close(() =>
                            callback(null, {
                                uidList,
                                highestModseq
                            })
                        );
                    }

                    if (highestModseq < message.modseq) {
                        highestModseq = message.modseq;
                    }

                    uidList.push(message.uid);
                    setImmediate(processNext);
                });
            };

            setImmediate(processNext);
        }
    );
};
