'use strict';

const SearchString = require('search-string').default;
const parser = require('logic-query-parser');
const { escapeRegexStr } = require('./tools');
const { ObjectId } = require('mongodb');

function parseSearchQuery(queryStr) {
    const queryTree = parser.parse(queryStr);

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

                if (node.left) {
                    if (
                        node.left?.lexeme?.type === 'string' &&
                        typeof node.left.lexeme.value === 'string' &&
                        node.left.lexeme.value.length > 1 &&
                        node.left.lexeme.value.at(-1) === ':' &&
                        node.right?.lexeme?.type === 'and' &&
                        node.right.left?.lexeme?.type === 'string' &&
                        node.right.left.lexeme.value
                    ) {
                        //
                        node.left.lexeme.value += `"${node.right.left.lexeme.value}"`;
                        node.right = node.right.right;
                    }

                    walkQueryTree(
                        node.left,
                        leafNode,
                        Object.assign({}, opts, {
                            condType: 'and'
                        })
                    );
                }

                if (node.right) {
                    walkQueryTree(
                        node.right,
                        leafNode,
                        Object.assign({}, opts, {
                            condType: 'and'
                        })
                    );
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
                    walkQueryTree(
                        node.left,
                        leafNode,
                        Object.assign({}, opts, {
                            condType: 'or'
                        })
                    );
                }
                if (node.right) {
                    walkQueryTree(
                        node.right,
                        leafNode,
                        Object.assign({}, opts, {
                            condType: 'or'
                        })
                    );
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

                    const leafNode = {
                        text: textValue ? { value: textValue, negated } : null,
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

const getMongoDBQuery = async (db, user, queryStr) => {
    const parsed = parseSearchQuery(queryStr);

    let hasTextFilter = false;

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
                $and: []
            };

            for (let entry of node.$and) {
                let subBranch = await walkTree(entry);
                branch.$and = branch.$and.concat(subBranch || []);
            }

            return branch;
        } else if (node.$or && node.$or.length) {
            let branch = {
                $or: []
            };

            for (let entry of node.$or) {
                let subBranch = await walkTree(entry);

                branch.$or = branch.$or.concat(subBranch || []);
            }

            // MongoDB allows a single $text expression per query. If this OR branch
            // only contains text queries, merge them into one $text search.
            // Used for fulltext OR query search
            if (branch.$or.length && branch.$or.every(entry => entry?.$text && typeof entry.$text.$search === 'string' && Object.keys(entry).length === 1)) {
                return {
                    $text: {
                        $search: branch.$or.map(entry => entry.$text.$search).join(' ')
                    }
                };
            }

            return branch;
        } else if (node.text) {
            let branch = {
                $text: {
                    $search: node.text.value
                }
            };

            if (node.text.negated) {
                branch = { $nor: [branch] };
            }

            hasTextFilter = true;

            return branch;
        } else if (node.keywords) {
            let branches = [];

            let keyword = Object.keys(node.keywords || {}).find(key => key && key !== 'negated');
            if (keyword) {
                let { value, negated } = node.keywords[keyword];
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

                    case 'in': {
                        value = (value || '').toString().trim();
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
                            branch = { mailbox: { $not: branch.mailbox } };
                        }
                        branches.push(branch);

                        break;
                    }

                    case 'thread':
                        {
                            value = (value || '').toString().trim();
                            if (/^[0-9a-f]{24}$/i.test(value)) {
                                let branch = { thread: new ObjectId(value) };
                                if (negated) {
                                    branch = { thread: { $not: branch.thread } };
                                }
                                branches.push(branch);
                            }
                        }
                        break;

                    case 'has': {
                        switch (value) {
                            case 'attachment': {
                                branches.push({ ha: true });
                                break;
                            }
                        }
                    }
                }
            }

            return branches;
        }
    };

    if (parsed && parsed.length) {
        let filter = await walkTree(Array.isArray(parsed) ? { $and: parsed } : parsed);

        let extras = { user };
        if (hasTextFilter) {
            extras.searchable = true;
        }

        return Object.assign({ user: null }, filter, extras);
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
            let branches = [];

            let keyword = Object.keys(node.keywords || {}).find(key => key && key !== 'negated');
            if (keyword) {
                let { value, negated } = node.keywords[keyword];
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

                    case 'in': {
                        value = (value || '').toString().trim();
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

                    case 'has': {
                        switch (value) {
                            case 'attachment': {
                                branches.push({ term: { ha: true } });
                                break;
                            }
                        }
                    }
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
