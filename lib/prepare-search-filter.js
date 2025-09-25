'use strict';

const ObjectId = require('mongodb').ObjectId;
const { escapeRegexStr } = require('./tools');

const uidRangeStringToQuery = uidRange => {
    if (!uidRange) {
        return;
    }

    let query;

    if (/^\d+$/.test(uidRange)) {
        query = Number(uidRange);
    } else if (/^\d+(,\d+)*$/.test(uidRange)) {
        query = {
            $in: uidRange
                .split(',')
                .map(uid => Number(uid))
                .sort((a, b) => a - b)
        };
    } else if (/^\d+:(\d+|\*)$/.test(uidRange)) {
        let parts = uidRange
            .split(':')
            .map(uid => Number(uid))
            .sort((a, b) => {
                if (a === '*') {
                    return 1;
                }
                if (b === '*') {
                    return -1;
                }
                return a - b;
            });
        if (parts[0] === parts[1]) {
            query = parts[0];
        } else {
            query = {
                $gte: parts[0]
            };
            if (!isNaN(parts[1])) {
                query.$lte = parts[1];
            }
        }
    }
    return query;
};

const prepareSearchFilter = async (db, user, payload) => {
    const mailbox = payload.mailbox ? new ObjectId(payload.mailbox) : false;
    const idQuery = uidRangeStringToQuery(payload.id);
    const thread = payload.thread ? new ObjectId(payload.thread) : false;

    const orTerms = payload.or || {};
    const orQuery = [];

    const query = payload.query;
    const datestart = payload.datestart || false;
    const dateend = payload.dateend || false;
    const filterFrom = payload.from;
    const filterTo = payload.to;
    const filterSubject = payload.subject;
    const filterAttachments = payload.attachments;
    const filterFlagged = payload.flagged;
    const filterUnseen = payload.unseen;
    const filterSeen = payload.seen;
    const filterSearchable = payload.searchable;
    const filterMinSize = payload.minSize;
    const filterMaxSize = payload.maxSize;

    let userData;
    try {
        userData = await db.users.collection('users').findOne(
            {
                _id: user
            },
            {
                projection: {
                    username: true,
                    address: true,
                    specialUse: true
                }
            }
        );
    } catch (err) {
        err.responseCode = 500;
        err.code = 'InternalDatabaseError';
        err.formattedMessage = 'Database Error';
        throw err;
    }

    if (!userData) {
        let err = new Error('This user does not exist');
        err.responseCode = 404;
        err.code = 'UserNotFound';
        err.formattedMessage = 'This user does not exist';
        throw err;
    }

    // NB! Scattered query, searches over all user mailboxes and all shards
    let filter = {
        user
    };

    if (query) {
        filter.searchable = true;
        filter.$text = { $search: query };
    } else if (orTerms.query) {
        filter.searchable = true;
        orQuery.push({ $text: { $search: orTerms.query } });
    }

    if (mailbox) {
        filter.mailbox = mailbox;
    } else if (filterSearchable) {
        // filter out Trash and Junk
        let nonJunkAndTrashMailboxesCount;

        try {
            nonJunkAndTrashMailboxesCount = await db.database.collection('mailboxes').countDocuments({ user, specialUse: { $nin: ['\\Junk', '\\Trash'] } });
        } catch {
            // ignore
        }

        if (nonJunkAndTrashMailboxesCount && nonJunkAndTrashMailboxesCount < 200) {
            // use $in query
            try {
                const mailboxes = await db.database
                    .collection('mailboxes')
                    .find({ user, specialUse: { $nin: ['\\Junk', '\\Trash'] } })
                    .project({
                        _id: true
                    })
                    .toArray();
                filter.mailbox = { $in: mailboxes.map(m => m._id) };
            } catch (err) {
                err.responseCode = 500;
                err.code = 'InternalDatabaseError';
                err.formattedMessage = 'Database Error';
                throw err;
            }
        } else {
            // default to $nin
            try {
                const mailboxes = await db.database
                    .collection('mailboxes')
                    .find({ user, specialUse: { $in: ['\\Junk', '\\Trash'] } })
                    .project({
                        _id: true
                    })
                    .toArray();
                filter.mailbox = { $nin: mailboxes.map(m => m._id) };
            } catch (err) {
                err.responseCode = 500;
                err.code = 'InternalDatabaseError';
                err.formattedMessage = 'Database Error';
                throw err;
            }
        }
    }

    if (filter.mailbox && idQuery) {
        filter.uid = idQuery;
    }

    if (thread) {
        filter.thread = thread;
    }

    if (filterFlagged) {
        // mailbox is not needed as there's a special index for flagged messages
        filter.flagged = true;
    }

    if (filterSeen) {
        filter.unseen = false;
        filter.searchable = true;
    }

    // Unseen takes precedence over seen
    if (filterUnseen) {
        filter.unseen = true;
        filter.searchable = true;
    }

    if (filterSearchable) {
        filter.searchable = true;
    }

    if (datestart) {
        if (!filter.idate) {
            filter.idate = {};
        }
        filter.idate.$gte = datestart;
    }

    if (dateend) {
        if (!filter.idate) {
            filter.idate = {};
        }
        filter.idate.$lte = dateend;
    }

    if (filterFrom) {
        let regex = escapeRegexStr(filterFrom);
        if (!filter.$and) {
            filter.$and = [];
        }
        filter.$and.push({
            headers: {
                $elemMatch: {
                    key: 'from',
                    value: {
                        $regex: regex,
                        $options: 'i'
                    }
                }
            }
        });
    }

    if (orTerms.from) {
        let regex = escapeRegexStr(orTerms.from);
        orQuery.push({
            headers: {
                $elemMatch: {
                    key: 'from',
                    value: {
                        $regex: regex,
                        $options: 'i'
                    }
                }
            }
        });
    }

    if (filterTo) {
        let regex = escapeRegexStr(filterTo);
        if (!filter.$and) {
            filter.$and = [];
        }
        filter.$and.push({
            $or: [
                {
                    headers: {
                        $elemMatch: {
                            key: 'to',
                            value: {
                                $regex: regex,
                                $options: 'i'
                            }
                        }
                    }
                },
                {
                    headers: {
                        $elemMatch: {
                            key: 'cc',
                            value: {
                                $regex: regex,
                                $options: 'i'
                            }
                        }
                    }
                }
            ]
        });
    }

    if (orTerms.to) {
        let regex = escapeRegexStr(orTerms.to);

        orQuery.push({
            headers: {
                $elemMatch: {
                    key: 'to',
                    value: {
                        $regex: regex,
                        $options: 'i'
                    }
                }
            }
        });

        orQuery.push({
            headers: {
                $elemMatch: {
                    key: 'cc',
                    value: {
                        $regex: regex,
                        $options: 'i'
                    }
                }
            }
        });
    }

    if (filterSubject) {
        let regex = escapeRegexStr(filterSubject);
        if (!filter.$and) {
            filter.$and = [];
        }
        filter.$and.push({
            headers: {
                $elemMatch: {
                    key: 'subject',
                    value: {
                        $regex: regex,
                        $options: 'i'
                    }
                }
            }
        });
    }

    if (orTerms.subject) {
        let regex = escapeRegexStr(orTerms.subject);
        orQuery.push({
            headers: {
                $elemMatch: {
                    key: 'subject',
                    value: {
                        $regex: regex,
                        $options: 'i'
                    }
                }
            }
        });
    }

    if (filterAttachments) {
        filter.ha = true;
    }

    if (filterMinSize) {
        filter.size = filter.size || {};
        filter.size.$gte = filterMinSize;
    }

    if (filterMaxSize) {
        filter.size = filter.size || {};
        filter.size.$lte = filterMaxSize;
    }

    if (orQuery.length) {
        filter.$or = orQuery;
    }

    return { filter, query };
};

module.exports = { uidRangeStringToQuery, prepareSearchFilter };
