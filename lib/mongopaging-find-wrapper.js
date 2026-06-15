'use strict';

const MongoPaging = require('mongo-cursor-pagination');
const ObjectId = require('mongodb').ObjectId;
const { EJSON } = require('bson');

const mongopagingFindWrapper = async (collection, opts) => {
    let currentPage = 1;

    const pageNextOriginalCursor = getCursorFromCursorWrapper(opts.next);
    const pagePrevOriginalCursor = getCursorFromCursorWrapper(opts.previous);

    if (opts.paginatedField && opts.paginatedField !== '_id') {
        // If the paginatedField is not just _id the the cursor is expected to be an array of 2 elements
        // applies to both cursors

        for (const pageOriginalCursor of [pagePrevOriginalCursor, pageNextOriginalCursor]) {
            const cursorData = getCursorDataFromCursor(pageOriginalCursor);

            if (pageOriginalCursor && cursorData) {
                if (!Array.isArray(cursorData)) {
                    const err = new Error('Invalid paging cursor');
                    err.code = 'cursorerr';
                    throw err;
                }

                if (cursorData.length < 2) {
                    // only 1 element
                    const err = new Error('Invalid paging cursor');
                    err.code = 'cursorerr';
                    throw err;
                }
            }
        }
    }

    if (pageNextOriginalCursor) {
        // Have next cursor
        const pageFromNextCursor = getPageFromMongopagingCursor(opts.next);
        opts.next = pageNextOriginalCursor; // For mongopaging only preserve the original inner cursor
        currentPage = pageFromNextCursor;
    } else if (pagePrevOriginalCursor) {
        // Have prev cursor
        delete opts.next; // Previous cursor overwrites next
        const pageFromPreviousCursor = getPageFromMongopagingCursor(opts.previous);
        opts.previous = pagePrevOriginalCursor; // For mongopaging only preserve the original inner cursor
        currentPage = pageFromPreviousCursor;
    }

    const listing = await MongoPaging.find(collection, opts);

    if (!listing.hasPrevious) {
        currentPage = 1;
    } else if (currentPage < 1) {
        // Against crafted cursors with negative pages
        currentPage = 1;
    }

    let nextCursor = listing.hasNext ? listing.next : false;

    if (nextCursor) {
        nextCursor = setPageToMongopagingCursor(nextCursor, currentPage + 1);
    }

    let previousCursor = listing.hasPrevious ? listing.previous : false;

    if (previousCursor) {
        previousCursor = setPageToMongopagingCursor(previousCursor, currentPage - 1 < 0 ? 0 : currentPage - 1);
    }

    return {
        listing,
        nextCursor,
        previousCursor,
        page: currentPage
    };
};

const mongopagingAggregateWrapper = async (collection, opts) => {
    let currentPage = 1;
    const paginatedField = opts.paginatedField || 'idate';

    const nextCursorData = getAggregateCursorData(opts.next, paginatedField);
    const previousCursorData = nextCursorData ? false : getAggregateCursorData(opts.previous, paginatedField);

    if (nextCursorData) {
        currentPage = getPageFromMongopagingCursor(opts.next);
    } else if (previousCursorData) {
        currentPage = getPageFromMongopagingCursor(opts.previous);
    }

    const sortDirection = opts.sortAscending ? 1 : -1;
    const pageSortDirection = previousCursorData ? -sortDirection : sortDirection;
    let cursorMatch = false;

    if (nextCursorData) {
        cursorMatch = getAggregateCursorMatch(nextCursorData, paginatedField, opts.sortAscending, false);
    } else if (previousCursorData) {
        cursorMatch = getAggregateCursorMatch(previousCursorData, paginatedField, opts.sortAscending, true);
    }

    const pipeline = [].concat(opts.pipeline || []);

    if (cursorMatch) {
        pipeline.push({
            $match: cursorMatch
        });
    }

    pipeline.push(
        {
            $sort: {
                [paginatedField]: pageSortDirection,
                _id: pageSortDirection
            }
        },
        {
            $limit: opts.limit + 1
        }
    );

    if (opts.projection) {
        pipeline.push({
            $project: opts.projection
        });
    }

    let results = await collection.aggregate(pipeline, opts.aggregateOptions || {}).toArray();

    const hasExtra = results.length > opts.limit;
    if (hasExtra) {
        results = results.slice(0, opts.limit);
    }

    if (previousCursorData) {
        results.reverse();
    }

    const hasPrevious = previousCursorData ? hasExtra : !!nextCursorData;
    const hasNext = previousCursorData ? !!results.length : hasExtra;

    if (!hasPrevious) {
        currentPage = 1;
    } else if (currentPage < 1) {
        currentPage = 1;
    }

    let nextCursor = hasNext && results.length ? getAggregateCursorString(results[results.length - 1], paginatedField) : false;
    if (nextCursor) {
        nextCursor = setPageToMongopagingCursor(nextCursor, currentPage + 1);
    }

    let previousCursor = hasPrevious && results.length ? getAggregateCursorString(results[0], paginatedField) : false;
    if (previousCursor) {
        previousCursor = setPageToMongopagingCursor(previousCursor, currentPage - 1 < 0 ? 0 : currentPage - 1);
    }

    return {
        listing: {
            results
        },
        nextCursor,
        previousCursor,
        page: currentPage
    };
};

function getPageFromMongopagingCursor(cursorString) {
    if (!cursorString) {
        return 1;
    }

    try {
        const cursorObjStr = EJSON.deserialize(Buffer.from(cursorString, 'base64url').toString());

        const cursorWrapperArr = EJSON.parse(cursorObjStr);

        if (cursorWrapperArr.length >= 2) {
            return cursorWrapperArr[1];
        }

        return 1; // Fallback
    } catch {
        return 1;
    }
}

function setPageToMongopagingCursor(cursorString, page) {
    if (!cursorString) {
        return false;
    }

    try {
        const cursorWrapperArr = [];
        cursorWrapperArr.push(Buffer.from(cursorString, 'base64url').toString()); // Preserve original string. Decode base64url to not double base64url encode
        cursorWrapperArr.push(page);

        const newCursorString = Buffer.from(EJSON.stringify(EJSON.serialize(cursorWrapperArr))).toString('base64url');
        return newCursorString;
    } catch {
        return false;
    }
}

function getCursorFromCursorWrapper(cursorWrapperString) {
    if (!cursorWrapperString) {
        return false;
    }

    try {
        const cursorObjStr = EJSON.deserialize(Buffer.from(cursorWrapperString, 'base64url').toString());

        const cursorWrapperArr = EJSON.parse(cursorObjStr);
        return Buffer.from(cursorWrapperArr[0]).toString('base64url');
    } catch {
        return false;
    }
}

function getCursorDataFromCursor(cursorString) {
    if (!cursorString) {
        return false;
    }
    return EJSON.parse(Buffer.from(cursorString, 'base64url').toString());
}

function getInvalidPagingCursorError() {
    const err = new Error('Invalid paging cursor');
    err.code = 'cursorerr';
    return err;
}

function getAggregateCursorData(cursorWrapperString, paginatedField) {
    if (!cursorWrapperString) {
        return false;
    }

    const cursorString = getCursorFromCursorWrapper(cursorWrapperString);
    const cursorData = cursorString && getCursorDataFromCursor(cursorString);

    if (!Array.isArray(cursorData) || cursorData.length < 2) {
        throw getInvalidPagingCursorError();
    }

    let paginatedValue = cursorData[0];
    if (paginatedField === 'idate' && !(paginatedValue instanceof Date)) {
        paginatedValue = new Date(paginatedValue);
    }

    let id = cursorData[1];
    try {
        if (!id || typeof id.toHexString !== 'function') {
            id = new ObjectId(id);
        }
    } catch (err) {
        throw getInvalidPagingCursorError();
    }

    if (paginatedField === 'idate' && (!paginatedValue || paginatedValue.toString() === 'Invalid Date')) {
        throw getInvalidPagingCursorError();
    }

    return {
        [paginatedField]: paginatedValue,
        _id: id
    };
}

function getAggregateCursorString(entry, paginatedField) {
    const paginatedValue = entry[paginatedField] instanceof Date ? entry[paginatedField].toISOString() : entry[paginatedField];
    return Buffer.from(JSON.stringify([paginatedValue, entry._id.toString()])).toString('base64url');
}

function getAggregateCursorMatch(cursorData, paginatedField, sortAscending, previous) {
    const op = previous ? (sortAscending ? '$lt' : '$gt') : sortAscending ? '$gt' : '$lt';

    return {
        $or: [
            {
                [paginatedField]: {
                    [op]: cursorData[paginatedField]
                }
            },
            {
                [paginatedField]: cursorData[paginatedField],
                _id: {
                    [op]: cursorData._id
                }
            }
        ]
    };
}

module.exports = {
    mongopagingFindWrapper,
    mongopagingAggregateWrapper,
    getPageFromMongopagingCursor,
    setPageToMongopagingCursor,
    getCursorFromCursorWrapper,
    getCursorDataFromCursor
};
