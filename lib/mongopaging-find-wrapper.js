'use strict';

const MongoPaging = require('mongo-cursor-pagination');
const ObjectId = require('mongodb').ObjectId;
const { EJSON } = require('bson');

const mongopagingFindWrapper = async (collection, opts) => {
    let currentPage = 1;

    if (opts.fields) {
        // MongoPaging deletes the paginated field from every result unless the field list names
        // it (removePaginatedFieldInResponse in mongo-cursor-pagination), which silently drops
        // idate from an ordered listing. Every caller wants the field it paged on, so it is
        // asked for here instead of at each call site.
        // The pagination package only retains _id for secondary sorts when it is numeric 1.
        opts.fields = Object.fromEntries(
            Object.entries({ [opts.paginatedField || '_id']: 1, _id: 1, ...opts.fields }).map(([key, value]) => [
                key,
                typeof value === 'boolean' ? Number(value) : value
            ])
        );
    }

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

    // Pagination v9 uses fields exclusively as a projection. Keep native driver options
    // such as maxTimeMS on the find call, rather than mixing them into that projection.
    const paginatedField = opts.paginatedField || '_id';
    const pagingCollection = {
        find(query) {
            // Pagination uses BSON 6, while the driver uses BSON 7. Pass Extended JSON
            // values to its token encoder, and rebuild decoded BSON values before querying.
            const cursor = collection.find(normalizeQueryBson(query), opts.findOptions || {});
            const toArray = cursor.toArray.bind(cursor);
            cursor.toArray = async () => (await toArray()).map(entry => mapPagingValues(entry, paginatedField, EJSON.serialize));
            return cursor;
        },
        findOne: (query, projection) => collection.findOne(normalizeQueryBson(query), { ...opts.findOptions, projection })
    };
    const listing = await MongoPaging.find(pagingCollection, opts);
    listing.results = listing.results.map(entry => mapPagingValues(entry, paginatedField, EJSON.deserialize));

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

// Only convert BSON instances, leaving ordinary query objects (including literal $oid
// and $date keys), Buffers, Dates and regular expressions in their original forms.
function normalizeQueryBson(value) {
    if (value && value._bsontype && typeof value.toExtendedJSON === 'function') {
        return EJSON.deserialize(value.toExtendedJSON(), { relaxed: false });
    }
    if (Array.isArray(value)) {
        return value.map(normalizeQueryBson);
    }
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeQueryBson(entry)]));
    }
    return value;
}

// Convert only cursor fields so BSON-looking keys in user metadata stay untouched.
function mapPagingValues(entry, paginatedField, convert) {
    const result = { ...entry };
    for (const field of new Set(['_id', paginatedField])) {
        const path = field.split('.');
        let source = entry;
        let target = result;
        for (const key of path.slice(0, -1)) {
            if (!source || typeof source[key] !== 'object' || source[key] === null) {
                source = null;
                break;
            }
            source = source[key];
            target[key] = { ...source };
            target = target[key];
        }
        const key = path[path.length - 1];
        if (source && Object.hasOwn(source, key)) {
            target[key] = source[key] === undefined ? undefined : convert(source[key]);
        }
    }
    return result;
}

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
    const pagePipeline = [];

    if (cursorMatch) {
        pagePipeline.push({
            $match: cursorMatch
        });
    }

    pagePipeline.push(
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
        pagePipeline.push({
            $project: opts.projection
        });
    }

    if (opts.includeTotal) {
        pipeline.push({
            $facet: {
                total: [{ $count: 'value' }],
                results: pagePipeline
            }
        });
    } else {
        pipeline.push(...pagePipeline);
    }

    const aggregateResults = await collection.aggregate(pipeline, opts.aggregateOptions || {}).toArray();
    let total;
    let results;

    if (opts.includeTotal) {
        const facetResult = aggregateResults[0] || {};
        total = facetResult.total && facetResult.total[0] ? facetResult.total[0].value : 0;
        results = facetResult.results || [];
    } else {
        results = aggregateResults;
    }

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

    const response = {
        listing: {
            results
        },
        nextCursor,
        previousCursor,
        page: currentPage
    };

    if (opts.includeTotal) {
        response.total = total;
    }

    return response;
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

    return {
        [paginatedField]: normalizeAggregateCursorValue(cursorData[0], paginatedField),
        _id: normalizeAggregateCursorValue(cursorData[1], '_id')
    };
}

function getAggregateCursorString(entry, paginatedField) {
    const paginatedValue =
        entry[paginatedField] && typeof entry[paginatedField].toHexString === 'function' ? entry[paginatedField].toString() : entry[paginatedField];
    return Buffer.from(EJSON.stringify([paginatedValue, entry._id.toString()])).toString('base64url');
}

function normalizeAggregateCursorValue(value, paginatedField) {
    if (paginatedField === 'idate' && !(value instanceof Date)) {
        const date = new Date(value);
        if (!date || date.toString() === 'Invalid Date') {
            throw getInvalidPagingCursorError();
        }
        return date;
    }

    if (paginatedField === '_id') {
        try {
            return new ObjectId(value && typeof value.toHexString === 'function' ? value.toString() : value);
        } catch (err) {
            throw getInvalidPagingCursorError();
        }
    }

    if (value && typeof value.toHexString === 'function') {
        return new ObjectId(value.toString());
    }

    return value;
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
