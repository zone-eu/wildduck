'use strict';

const SearchString = require('search-string').default;
const parser = require('logic-query-parser');
const { escapeRegexStr } = require('./tools');
const { uidRangeStringToQuery, toMongoAndTextSearch, getSearchableMailboxQuery } = require('./prepare-search-filter');
const { ObjectId } = require('mongodb');

const getBooleanValue = value => {
    if (typeof value === 'boolean') {
        return value;
    }

    switch ((value || '').toString().trim().toLowerCase()) {
        case 'true':
        case '1':
        case 'yes':
        case 'y':
        case 'on':
            return true;
        case 'false':
        case '0':
        case 'no':
        case 'n':
        case 'off':
            return false;
    }

    return false;
};

const getNumberValue = value => {
    if (typeof value === 'number' && isFinite(value)) {
        return value;
    }

    let num = Number(value);
    return isFinite(num) ? num : false;
};

const getDateValue = value => {
    let date = new Date(value);
    return isNaN(date.getTime()) ? false : date;
};

const createMongoTextQuery = searchValue => ({
    $text: {
        $search: searchValue
    }
});

const formatTextSearchValue = (value, opts = {}) => (opts.useAndSearch === true && opts.mode !== 'or' ? toMongoAndTextSearch(value) : value);

const createPhraseRegexClauses = value => {
    const regex = escapeRegexStr(value).replace(/\s+/g, '\\s+');
    return [
        {
            text: {
                $regex: regex,
                $options: 'i'
            }
        },
        {
            headers: {
                $elemMatch: {
                    key: 'subject',
                    value: {
                        $regex: regex,
                        $options: 'i'
                    }
                }
            }
        }
    ];
};

const createPhraseQuery = (value, negated) => {
    const clauses = createPhraseRegexClauses(value);
    return negated ? { $nor: clauses } : { $or: clauses };
};

const hasUnclosedQuote = queryStr => {
    let quoteCount = 0;
    let escaped = false;

    for (let i = 0; i < queryStr.length; i++) {
        if (escaped) {
            escaped = false;
            continue;
        }

        if (queryStr.charAt(i) === '\\') {
            escaped = true;
            continue;
        }

        if (queryStr.charAt(i) === '"') {
            quoteCount++;
        }
    }

    return quoteCount % 2 === 1;
};

const parseLogicQuery = queryStr => {
    const query = (queryStr || '').toString();

    try {
        return parser.parse(query);
    } catch (err) {
        if (err && err.message === "Can't reach end of quoted string" && hasUnclosedQuote(query)) {
            return parser.parse(`${query}"`);
        }

        throw err;
    }
};

function parseSearchQuery(queryStr) {
    const queryTree = parseLogicQuery(queryStr);

    let result = [];

    let walkQueryTree = (node, branch, opts) => {
        switch (node.lexeme && node.lexeme.type) {
            case 'and': {
                let leafNode;
                if (opts.condType === 'and') {
                    leafNode = branch;
                } else {
                    let node = { $and: [] };
                    branch.push(node);
                    leafNode = node.$and;
                }

                if (node.left?.lexeme?.type === 'string' && node.left.lexeme.value === '-' && node.right) {
                    if (node.right.lexeme?.type === 'and' && node.right.left) {
                        walkQueryTree(node.right.left, leafNode, { ...opts, condType: 'and', negated: !opts.negated });
                        if (node.right.right) {
                            walkQueryTree(node.right.right, leafNode, { ...opts, condType: 'and' });
                        }
                    } else {
                        walkQueryTree(node.right, leafNode, { ...opts, condType: 'and', negated: !opts.negated });
                    }
                    return;
                }

                if (node.left) {
                    if (
                        node.left?.lexeme?.type === 'string' &&
                        typeof node.left.lexeme.value === 'string' &&
                        node.left.lexeme.value.length > 1 &&
                        node.left.lexeme.value.at(-1) === ':' &&
                        /^-?(from|to|cc|bcc|subject|in):$/i.test(node.left.lexeme.value) &&
                        node.right?.lexeme?.type === 'string' &&
                        node.right.lexeme.value
                    ) {
                        node.left.lexeme.value += `"${node.right.lexeme.value}"`;
                        node.right = null;
                    } else if (
                        node.left?.lexeme?.type === 'string' &&
                        typeof node.left.lexeme.value === 'string' &&
                        node.left.lexeme.value.length > 1 &&
                        node.left.lexeme.value.at(-1) === ':' &&
                        /^-?(from|to|cc|bcc|subject|in):$/i.test(node.left.lexeme.value) &&
                        node.right?.lexeme?.type === 'and' &&
                        node.right.left?.lexeme?.type === 'string' &&
                        node.right.left.lexeme.value
                    ) {
                        //
                        node.left.lexeme.value += `"${node.right.left.lexeme.value}"`;
                        node.right = node.right.right;
                    }

                    walkQueryTree(node.left, leafNode, { ...opts, condType: 'and' });
                }

                if (node.right) {
                    walkQueryTree(node.right, leafNode, { ...opts, condType: 'and' });
                }

                return;
            }

            case 'or': {
                let leafNode;
                if (opts.condType === 'or') {
                    leafNode = branch;
                } else {
                    let node = { $or: [] };
                    branch.push(node);
                    leafNode = node.$or;
                }

                if (node.left) {
                    walkQueryTree(node.left, leafNode, { ...opts, condType: 'or' });
                }
                if (node.right) {
                    walkQueryTree(node.right, leafNode, { ...opts, condType: 'or' });
                }

                return;
            }

            case 'string':
                {
                    const searchString = SearchString.parse(`${opts.negated ? '-' : ''}${node.lexeme.value}`);
                    let parsedQuery = searchString.getParsedQuery();

                    node.parsed = { searchString, parsedQuery };

                    let keywords = {};
                    if (parsedQuery) {
                        for (let key of Object.keys(parsedQuery)) {
                            if (key === 'exclude') {
                                for (let subKey of Object.keys(parsedQuery[key])) {
                                    keywords[subKey] = { value: parsedQuery[key][subKey].flatMap(entry => entry).shift(), negated: true };
                                }
                            } else if (Array.isArray(parsedQuery[key])) {
                                keywords[key] = { value: parsedQuery[key].flatMap(entry => entry).shift(), negated: false };
                            }
                        }
                    }

                    let negated = opts.negated;

                    let textValue =
                        searchString
                            .getTextSegments()
                            .flatMap(entry => {
                                negated = entry.negated ? !opts.negated : !!opts.negated;

                                return entry.text;
                            })
                            .join(' ') || null;

                    // logic-query-parser emits multi-word string lexemes only for quoted input.
                    const exactPhrase = typeof node.lexeme.value === 'string' && /\s/.test(node.lexeme.value);
                    const leafNode = {
                        text: textValue ? { value: exactPhrase ? node.lexeme.value : textValue, negated, exactPhrase } : null,
                        keywords: Object.keys(keywords).length ? keywords : null,
                        value: node.lexeme.value
                    };
                    branch.push(leafNode);
                }
                break;
        }
    };

    walkQueryTree(queryTree, result, { condType: 'and' });

    return result;
}

const getMongoDBQuery = async (db, user, queryStr, opts = {}) => {
    const parsed = parseSearchQuery(queryStr);

    let hasTextFilter = false;
    const isEmptyBranch = entry =>
        !entry ||
        (Array.isArray(entry) && !entry.length) ||
        (entry.$and && !entry.$and.length) ||
        (entry.$or && !entry.$or.length) ||
        (entry.$nor && !entry.$nor.length);
    const appendBranch = (branches, branch) => {
        for (let entry of Array.isArray(branch) ? branch : [branch]) {
            if (!isEmptyBranch(entry)) {
                branches.push(entry);
            }
        }
    };
    const getTextSearchValue = (entry, queryOpts = opts) => {
        if (entry.rawSearch) {
            return entry.negated ? `-${entry.textValue}` : entry.textValue;
        }

        const searchValue = formatTextSearchValue(entry.textValue, queryOpts);
        return entry.negated ? `-${searchValue}` : searchValue;
    };
    const createTextEntry = (value, negated) => {
        const entry = {
            isTextQuery: true,
            textValue: value,
            negated: !!negated
        };
        const searchValue = getTextSearchValue(entry);
        return {
            ...entry,
            query: createMongoTextQuery(searchValue)
        };
    };
    const isTextEntry = entry => !!entry?.isTextQuery;
    const unwrapQueryEntry = entry => (isTextEntry(entry) ? entry.query : entry);
    const createTextRegexQuery = entry => createPhraseQuery(entry.textValue, entry.negated);
    const createRawTextRegexQuery = entry => ({ $or: entry.entries.map(createTextRegexQuery) });
    const mergeTextEntries = (entries, queryOpts = opts) => {
        const searchValue = entries.map(entry => getTextSearchValue(entry, queryOpts)).join(' ');
        return {
            isTextQuery: true,
            textValue: searchValue,
            negated: false,
            rawSearch: true,
            entries,
            query: createMongoTextQuery(searchValue)
        };
    };

    let walkTree = async node => {
        if (Array.isArray(node)) {
            let branches = [];
            for (let entry of node) {
                appendBranch(branches, await walkTree(entry));
            }
            return branches;
        }

        if (node.$and && node.$and.length) {
            let branch = {
                $and: []
            };

            for (let entry of node.$and) {
                let subBranch = await walkTree(entry);
                appendBranch(branch.$and, subBranch);
            }

            if (!branch.$and.length) {
                return false;
            }

            // MongoDB allows a single $text expression per query. If this AND branch
            // has multiple direct text clauses, merge them into one.
            // Used for fulltext AND query (default) (example: `q=term1 term2`)
            if (branch.$and.length > 1) {
                let textTerms = [];
                let nonTextTerms = [];

                for (let entry of branch.$and) {
                    if (isTextEntry(entry)) {
                        textTerms.push(entry);
                    } else {
                        nonTextTerms.push(entry);
                    }
                }

                if (textTerms.length > 1) {
                    let rawTextTerms = textTerms.filter(entry => entry.rawSearch);
                    let directTextTerms = textTerms.filter(entry => !entry.rawSearch);

                    if (rawTextTerms.length) {
                        branch.$and = [unwrapQueryEntry(rawTextTerms.shift())]
                            .concat(rawTextTerms.map(createRawTextRegexQuery))
                            .concat(directTextTerms.map(createTextRegexQuery))
                            .concat(nonTextTerms);
                    } else {
                        branch.$and = [unwrapQueryEntry(mergeTextEntries(textTerms))].concat(nonTextTerms);
                    }
                } else {
                    branch.$and = branch.$and.map(unwrapQueryEntry);
                }
            } else {
                branch.$and = branch.$and.map(unwrapQueryEntry);
            }

            return branch;
        } else if (node.$or && node.$or.length) {
            let branch = {
                $or: []
            };

            for (let entry of node.$or) {
                let subBranch = await walkTree(entry);

                appendBranch(branch.$or, subBranch);
            }

            if (!branch.$or.length) {
                return false;
            }

            // MongoDB allows a single $text expression per query. If this OR branch
            // only contains text queries, merge them into one $text search.
            // Used for fulltext OR query search
            if (branch.$or.length && branch.$or.every(isTextEntry)) {
                return mergeTextEntries(branch.$or, { ...opts, mode: 'or' });
            }

            branch.$or = branch.$or.map(unwrapQueryEntry);
            return branch;
        } else if (node.text) {
            let branch = node.text.exactPhrase ? createPhraseQuery(node.text.value, node.text.negated) : createTextEntry(node.text.value, node.text.negated);

            hasTextFilter = true;

            return branch;
        } else if (node.keywords) {
            const branches = [];

            const keywordKey = Object.keys(node.keywords || {}).find(key => key && key !== 'negated');
            if (keywordKey) {
                const keyword = keywordKey.toLowerCase();
                let { value, negated } = node.keywords[keywordKey];
                const keywordValue = (value || '').toString().trim();
                value = keywordValue.toLowerCase();
                switch (keyword) {
                    case 'from':
                    case 'subject':
                        {
                            let regex = escapeRegexStr(value);
                            let branch = {
                                headers: {
                                    $elemMatch: {
                                        key: keyword,
                                        value: {
                                            $regex: regex,
                                            $options: 'i'
                                        }
                                    }
                                }
                            };
                            if (negated) {
                                branch = { headers: { $not: branch.headers } };
                            }
                            branches.push(branch);
                        }
                        break;

                    case 'to':
                        {
                            let regex = escapeRegexStr(value);
                            let toBranches = [];
                            for (let toKey of ['to', 'cc', 'bcc']) {
                                let branch = {
                                    headers: {
                                        $elemMatch: {
                                            key: toKey,
                                            value: {
                                                $regex: regex,
                                                $options: 'i'
                                            }
                                        }
                                    }
                                };
                                toBranches.push(branch);
                            }

                            if (negated) {
                                branches.push({ $nor: toBranches });
                            } else {
                                branches.push({ $or: toBranches });
                            }
                        }
                        break;

                    case 'cc':
                    case 'bcc':
                        {
                            let regex = escapeRegexStr(value);
                            let branch = {
                                headers: {
                                    $elemMatch: {
                                        key: keyword,
                                        value: {
                                            $regex: regex,
                                            $options: 'i'
                                        }
                                    }
                                }
                            };
                            if (negated) {
                                branch = { headers: { $not: branch.headers } };
                            }
                            branches.push(branch);
                        }
                        break;

                    case 'in': {
                        value = keywordValue;
                        let resolveQuery = { user, $or: [] };
                        if (/^[0-9a-f]{24}$/i.test(value)) {
                            resolveQuery.$or.push({ _id: new ObjectId(value) });
                        } else if (/^Inbox$/i.test(value)) {
                            resolveQuery.$or.push({ path: 'INBOX' });
                        } else {
                            resolveQuery.$or.push({ path: value });
                            if (/^\/?(spam|junk)/i.test(value)) {
                                resolveQuery.$or.push({ specialUse: '\\Junk' });
                            } else if (/^\/?(sent)/i.test(value)) {
                                resolveQuery.$or.push({ specialUse: '\\Sent' });
                            } else if (/^\/?(trash|deleted)/i.test(value)) {
                                resolveQuery.$or.push({ specialUse: '\\Trash' });
                            } else if (/^\/?(drafts)/i.test(value)) {
                                resolveQuery.$or.push({ specialUse: '\\Drafts' });
                            }
                        }

                        let mailboxEntry = await db.database.collection('mailboxes').findOne(resolveQuery, { project: { _id: -1 } });

                        let branch = { mailbox: mailboxEntry ? mailboxEntry._id : new ObjectId('0'.repeat(24)) };
                        if (negated) {
                            branch = { $nor: [branch] };
                        }
                        branches.push(branch);

                        break;
                    }

                    case 'mailbox':
                        {
                            value = (value || '').toString().trim();
                            if (/^[0-9a-f]{24}$/i.test(value)) {
                                let branch = { mailbox: new ObjectId(value) };
                                if (negated) {
                                    branch = { $nor: [branch] };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'thread':
                        {
                            value = (value || '').toString().trim();
                            if (/^[0-9a-f]{24}$/i.test(value)) {
                                let branch = { thread: new ObjectId(value) };
                                if (negated) {
                                    branch = { $nor: [branch] };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'id':
                        {
                            let uidQuery = uidRangeStringToQuery((value || '').toString().trim());
                            if (uidQuery) {
                                let branch = { uid: uidQuery };
                                if (negated) {
                                    branch = { $nor: [branch] };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'datestart':
                    case 'after':
                    case 'newer':
                        {
                            let date = getDateValue(value);
                            if (date) {
                                let branch = { idate: { $gte: date } };
                                if (negated) {
                                    branch = { $nor: [branch] };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'dateend':
                    case 'before':
                    case 'older':
                        {
                            let date = getDateValue(value);
                            if (date) {
                                let branch = { idate: { $lte: date } };
                                if (negated) {
                                    branch = { $nor: [branch] };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'minsize':
                        {
                            let size = getNumberValue(value);
                            if (size !== false) {
                                let branch = { size: { $gte: size } };
                                if (negated) {
                                    branch = { $nor: [branch] };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'maxsize':
                        {
                            let size = getNumberValue(value);
                            if (size !== false) {
                                let branch = { size: { $lte: size } };
                                if (negated) {
                                    branch = { $nor: [branch] };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'attachments':
                        {
                            let hasAttachments = getBooleanValue(value);
                            if (hasAttachments) {
                                let branch = { ha: true };
                                if (negated) {
                                    branch = { ha: { $ne: true } };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'flagged':
                        {
                            let flagged = getBooleanValue(value);
                            if (flagged) {
                                let branch = { flagged: true };
                                if (negated) {
                                    branch = { flagged: { $ne: true } };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'seen':
                        {
                            let seen = getBooleanValue(value);
                            if (seen) {
                                let branch = { unseen: false, searchable: true };
                                if (negated) {
                                    branch = { unseen: { $ne: false } };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'unseen':
                        {
                            let unseen = getBooleanValue(value);
                            if (unseen) {
                                let branch = { unseen: true, searchable: true };
                                if (negated) {
                                    branch = { unseen: { $ne: true } };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'searchable':
                        {
                            let searchable = getBooleanValue(value);
                            if (searchable) {
                                let branch = {
                                    mailbox: await getSearchableMailboxQuery(db, user)
                                };

                                if (negated) {
                                    branch = { mailbox: { $not: branch.mailbox } };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'has':
                        switch (value) {
                            case 'attachment':
                            case 'attachments': {
                                let branch = { ha: true };
                                if (negated) {
                                    branch = { ha: { $ne: true } };
                                }
                                branches.push(branch);
                                break;
                            }
                        }
                        break;

                    case 'is':
                        switch (value) {
                            case 'starred': {
                                let branch = { flagged: true };
                                if (negated) {
                                    branch = { flagged: { $ne: true } };
                                }
                                branches.push(branch);
                                break;
                            }

                            case 'read': {
                                let branch = { unseen: false, searchable: true };
                                if (negated) {
                                    branch = { unseen: { $ne: false } };
                                }
                                branches.push(branch);
                                break;
                            }

                            case 'unread': {
                                let branch = { unseen: true, searchable: true };
                                if (negated) {
                                    branch = { unseen: { $ne: true } };
                                }
                                branches.push(branch);
                                break;
                            }
                        }
                        break;
                }
            }

            return branches;
        }
    };

    if (parsed && parsed.length) {
        let filter = await walkTree(Array.isArray(parsed) ? { $and: parsed } : parsed);

        if (isEmptyBranch(filter)) {
            return { user: false };
        }

        if (opts.searchable) {
            if (!filter.$and) {
                filter = { $and: [filter] };
            }

            filter.$and.push({
                mailbox: await getSearchableMailboxQuery(db, user)
            });
        }

        let extras = { user };
        if (hasTextFilter) {
            extras.searchable = true;
        }

        return { user: null, ...filter, ...extras };
    }

    return { user: false };
};

const getElasticSearchQuery = async (db, user, queryStr) => {
    const parsed = parseSearchQuery(queryStr);

    let searchQuery = {
        bool: {
            must: [
                {
                    term: {
                        user: (user || '').toString().trim()
                    }
                }
            ]
        }
    };

    let walkTree = async node => {
        if (Array.isArray(node)) {
            let branches = [];
            for (let entry of node) {
                branches.push(await walkTree(entry));
            }
            return branches;
        }

        if (node.$and && node.$and.length) {
            let branch = {
                bool: { must: [] }
            };

            for (let entry of node.$and) {
                let subBranch = await walkTree(entry);
                branch.bool.must = branch.bool.must.concat(subBranch || []);
            }

            return branch;
        } else if (node.$or && node.$or.length) {
            let branch = {
                bool: { should: [], minimum_should_match: 1 }
            };

            for (let entry of node.$or) {
                let subBranch = await walkTree(entry);

                branch.bool.should = branch.bool.should.concat(subBranch || []);
            }

            return branch;
        } else if (node.text) {
            let branch = {
                bool: {
                    should: [
                        {
                            match: {
                                subject: {
                                    query: node.text.value,
                                    operator: 'and'
                                }
                            }
                        },
                        {
                            match: {
                                text: {
                                    query: node.text.value,
                                    operator: 'and'
                                }
                            }
                        },
                        {
                            match: {
                                html: {
                                    query: node.text.value,
                                    operator: 'and'
                                }
                            }
                        }
                    ],
                    minimum_should_match: 1
                }
            };

            if (node.text.negated) {
                branch = { bool: { must_not: branch.bool.should } };
            }

            return branch;
        } else if (node.keywords) {
            const branches = [];

            const keywordKey = Object.keys(node.keywords || {}).find(key => key && key !== 'negated');
            if (keywordKey) {
                const keyword = keywordKey.toLowerCase();
                let { value, negated } = node.keywords[keywordKey];
                const keywordValue = (value || '').toString().trim();
                value = keywordValue.toLowerCase();
                switch (keyword) {
                    case 'subject':
                        {
                            let branch = {
                                match: {
                                    subject: {
                                        query: value,
                                        operator: 'and'
                                    }
                                }
                            };
                            if (negated) {
                                branch = { bool: { must_not: branch } };
                            }
                            branches.push(branch);
                        }
                        break;

                    case 'from':
                        {
                            let branch = {
                                bool: {
                                    should: [
                                        {
                                            match: {
                                                [`from.name`]: {
                                                    query: value,
                                                    operator: 'and'
                                                }
                                            }
                                        },
                                        {
                                            term: {
                                                [`from.address`]: value
                                            }
                                        }
                                    ],
                                    minimum_should_match: 1
                                }
                            };
                            if (negated) {
                                branch = { bool: { must_not: branch } };
                            }
                            branches.push(branch);
                        }
                        break;

                    case 'to':
                        {
                            let branch = {
                                bool: {
                                    should: [],
                                    minimum_should_match: 1
                                }
                            };

                            for (let toKey of ['to', 'cc', 'bcc']) {
                                branch.bool.should.push(
                                    {
                                        match: {
                                            [`${toKey}.name`]: {
                                                query: value,
                                                operator: 'and'
                                            }
                                        }
                                    },
                                    {
                                        term: {
                                            [`${toKey}.address`]: value
                                        }
                                    }
                                );
                            }

                            if (negated) {
                                branch = { bool: { must_not: branch } };
                            }
                            branches.push(branch);
                        }
                        break;

                    case 'cc':
                    case 'bcc':
                        {
                            let branch = {
                                bool: {
                                    should: [
                                        {
                                            match: {
                                                [`${keyword}.name`]: {
                                                    query: value,
                                                    operator: 'and'
                                                }
                                            }
                                        },
                                        {
                                            term: {
                                                [`${keyword}.address`]: value
                                            }
                                        }
                                    ],
                                    minimum_should_match: 1
                                }
                            };
                            if (negated) {
                                branch = { bool: { must_not: branch } };
                            }
                            branches.push(branch);
                        }
                        break;

                    case 'in': {
                        value = keywordValue;
                        let resolveQuery = { user, $or: [] };
                        if (/^[0-9a-f]{24}$/i.test(value)) {
                            resolveQuery.$or.push({ _id: new ObjectId(value) });
                        } else if (/^Inbox$/i.test(value)) {
                            resolveQuery.$or.push({ path: 'INBOX' });
                        } else {
                            resolveQuery.$or.push({ path: value });
                            if (/^\/?(spam|junk)/i.test(value)) {
                                resolveQuery.$or.push({ specialUse: '\\Junk' });
                            } else if (/^\/?(sent)/i.test(value)) {
                                resolveQuery.$or.push({ specialUse: '\\Sent' });
                            } else if (/^\/?(trash|deleted)/i.test(value)) {
                                resolveQuery.$or.push({ specialUse: '\\Trash' });
                            } else if (/^\/?(drafts)/i.test(value)) {
                                resolveQuery.$or.push({ specialUse: '\\Drafts' });
                            }
                        }

                        let mailboxEntry = await db.database.collection('mailboxes').findOne(resolveQuery, { project: { _id: -1 } });

                        let branch = { term: { mailbox: (mailboxEntry ? mailboxEntry._id : new ObjectId('0'.repeat(24))).toString() } };
                        if (negated) {
                            branch = { bool: { must_not: [branch] } };
                        }
                        branches.push(branch);

                        break;
                    }

                    case 'thread':
                        {
                            value = (value || '').toString().trim();
                            if (/^[0-9a-f]{24}$/i.test(value)) {
                                let branch = { term: { thread: value } };
                                if (negated) {
                                    branch = { bool: { must_not: [branch] } };
                                }
                                if (negated) {
                                    branch = { bool: { must_not: [branch] } };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'has':
                        switch (value) {
                            case 'attachment':
                            case 'attachments': {
                                let branch = { term: { ha: true } };
                                if (negated) {
                                    branch = { bool: { must_not: [branch] } };
                                }
                                branches.push(branch);
                                break;
                            }
                        }
                        break;

                    case 'is':
                        switch (value) {
                            case 'starred': {
                                let branch = { term: { flagged: true } };
                                if (negated) {
                                    branch = { bool: { must_not: [branch] } };
                                }
                                branches.push(branch);
                                break;
                            }

                            case 'read': {
                                let branch = { term: { unseen: false } };
                                if (negated) {
                                    branch = { bool: { must_not: [branch] } };
                                }
                                branches.push(branch);
                                break;
                            }

                            case 'unread': {
                                let branch = { term: { unseen: true } };
                                if (negated) {
                                    branch = { bool: { must_not: [branch] } };
                                }
                                branches.push(branch);
                                break;
                            }
                        }
                        break;
                }
            }

            return branches;
        }
    };

    if (parsed && parsed.length) {
        let filter = await walkTree({ $and: parsed });
        searchQuery.bool.must = searchQuery.bool.must.concat(filter);
    }

    return searchQuery;
};

module.exports = { parseSearchQuery, getMongoDBQuery, getElasticSearchQuery };
/*
if (process.env.DEBUG_TEST_QUERY && process.env.NODE_ENV !== 'production') {
    const util = require('util'); // eslint-disable-line
    let main = () => {
        let db = require('./db'); // eslint-disable-line
        db.connect(() => {
            let run = async () => {
                let queries = ['from:"amy namy" kupi in:spam to:greg has:attachment -subject:"dinner and movie tonight" (jupi OR subject:tere)'];

                for (let query of queries) {
                    console.log('PARSED QUERY');
                    console.log(util.inspect({ query, parsed: parseSearchQuery(query) }, false, 22, true));
                    console.log('MongoDB');
                    console.log(util.inspect({ query, filter: await getMongoDBQuery(db, new ObjectId('64099fff101ca2ef6aad8be7'), query) }, false, 22, true));
                    console.log('ElasticSearch');
                    console.log(
                        util.inspect({ query, filter: await getElasticSearchQuery(db, new ObjectId('64099fff101ca2ef6aad8be7'), query) }, false, 22, true)
                    );
                }
            };

            run()
                .catch(err => console.error(err))
                .finally(() => process.exit());
        });
    };
    main();
}
*/
