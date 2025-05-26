'use strict';

const MongoPaging = require('mongo-cursor-pagination');
const { EJSON } = require('bson');

const mongopagingFindWrapper = async (collection, opts) => {
    let currentPage = 1;

    const pageNextOriginalCursor = getCursorFromCursorWrapper(opts.next);
    const pagePrevOriginalCursor = getCursorFromCursorWrapper(opts.previous);

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

module.exports = {
    mongopagingFindWrapper,
    getPageFromMongopagingCursor,
    setPageToMongopagingCursor,
    getCursorFromCursorWrapper
};
