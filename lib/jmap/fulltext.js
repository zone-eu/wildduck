'use strict';

// Text and body conditions of Email/query through OpenSearch (or Elasticsearch), for accounts whose
// messages are indexed by indexer.js: the search index holds the whole stored body (plain text and
// HTML), while the MongoDB text index covers only the beginning of the plain text. Used when the
// [elasticsearch] section is enabled and the account has the indexing feature flag, like the REST API.

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const { getClient } = require('../elasticsearch');
const { MethodError } = require('./errors');

// fields of an indexed message that hold its text; the address fields are keywords, so the names are searched
const BODY_FIELDS = ['text', 'html'];
const TEXT_FIELDS = ['subject', 'from.name', 'to.name', 'cc.name', 'bcc.name', ...BODY_FIELDS];

/**
 * True when text conditions of this account are answered by the search index. Read once per request.
 *
 * @returns {Promise<Boolean>}
 */
function fulltextEnabled(context) {
    if (!context.cache.fulltext) {
        context.cache.fulltext = (async () => {
            const settings = config.elasticsearch;
            if (!settings || !settings.enabled) {
                return false;
            }
            if (config.enabledFeatureFlags && config.enabledFeatureFlags.indexer) {
                return true;
            }
            return !!(await context.deps.redis.sismember('feature:indexing', context.account.user.toString()));
        })();
    }
    return context.cache.fulltext;
}

/** One search term: a phrase in the body (body) or in the body, the names and the indexed headers (text) */
function termQuery(field, text) {
    const phrase = { multi_match: { query: text, type: 'phrase', fields: field === 'body' ? BODY_FIELDS : TEXT_FIELDS } };
    if (field === 'body') {
        return phrase;
    }
    return {
        bool: {
            should: [phrase, { nested: { path: 'headers', query: { match_phrase: { 'headers.value': text } } } }],
            minimum_should_match: 1
        }
    };
}

/**
 * Ids of the account's messages where every term occurs, at most `limit` of them. Every clause is a
 * filter (no scoring) and the hits are the newest matches by internal date: a search with more matches
 * than `limit` is cut to the newest `limit` ones, like the other capped id lists of email-search.js. The
 * cut is detected (the total is counted one past the limit) and logged.
 *
 * @param {Object} context
 * @param {String} field 'text' or 'body'
 * @param {String[]} terms Phrases, all of which must match
 * @param {Number} limit
 * @param {Number} maxTimeMS
 * @returns {Promise<String[]>} Message ids (24 hex)
 */
async function searchIds(context, field, terms, limit, maxTimeMS) {
    const body = {
        size: limit,
        _source: false,
        track_total_hits: limit + 1,
        sort: [{ idate: { order: 'desc' } }],
        query: {
            bool: {
                filter: [{ term: { user: context.account.user.toString() } }, ...terms.map(text => termQuery(field, text))]
            }
        }
    };
    let response;
    try {
        response = await getClient().search({ index: config.elasticsearch.index, body }, { requestTimeout: maxTimeMS });
    } catch (err) {
        // the search service is down or too slow: like a database timeout, the client may try again
        log.error('JMAP', 'Search index query failed user=%s error=%s', context.account.user, err.message);
        throw new MethodError('serverUnavailable', { description: 'the search service did not answer' });
    }
    const result = (response && response.body && response.body.hits) || {};
    const total = result.total && typeof result.total === 'object' ? result.total.value : result.total;
    if (total > limit) {
        log.verbose('JMAP', 'Search index query cut to the newest %s matches user=%s', limit, context.account.user);
    }
    return (result.hits || []).map(hit => hit._id).filter(id => /^[0-9a-f]{24}$/.test(id));
}

module.exports = { fulltextEnabled, searchIds };
