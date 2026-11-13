'use strict';

// Capability URNs and the capability objects of the session resource (RFC 8620 2, RFC 8621 1.3 and
// the extensions WildDuck implements). A capability is advertised only once everything it covers is
// implemented: the `methods` registry decides that, see request.js.

const URN = Object.freeze({
    core: 'urn:ietf:params:jmap:core',
    mail: 'urn:ietf:params:jmap:mail',
    submission: 'urn:ietf:params:jmap:submission',
    vacationresponse: 'urn:ietf:params:jmap:vacationresponse',
    blob: 'urn:ietf:params:jmap:blob',
    quota: 'urn:ietf:params:jmap:quota',
    contacts: 'urn:ietf:params:jmap:contacts',
    calendars: 'urn:ietf:params:jmap:calendars',
    webpushVapid: 'urn:ietf:params:jmap:webpush-vapid'
});

// Email/query sorts (RFC 8621 4.4.2), advertised as emailQuerySortOptions
const EMAIL_SORTS = ['receivedAt', 'sentAt', 'size', 'from', 'to', 'subject', 'hasKeyword', 'allInThreadHaveKeyword', 'someInThreadHaveKeyword'];

// RFC 4790 collations applied by string comparisons (see email-search.js)
const COLLATIONS = ['i;ascii-numeric', 'i;ascii-casemap', 'i;unicode-casemap'];

const DEFAULT_LIMITS = Object.freeze({
    maxSizeUpload: 50 * 1024 * 1024,
    maxConcurrentUpload: 4,
    maxSizeRequest: 10 * 1024 * 1024,
    maxConcurrentRequests: 8,
    maxCallsInRequest: 32,
    maxObjectsInGet: 1500,
    maxObjectsInSet: 500,
    uploadQuota: 200 * 1024 * 1024,
    maxUploads: 1000,
    uploadTtl: 24 * 3600,
    // octets the /get calls of one request return together (not advertised, see response-budget.js)
    maxResponseBytes: 64 * 1024 * 1024
});

/** The effective limits: configured values over the defaults. */
const limitsFrom = config => Object.assign({}, DEFAULT_LIMITS, (config && config.limits) || {});

/**
 * The `capabilities` object of the session: server wide capability information.
 *
 * @param {Object} limits Effective limits
 * @param {Object} accountCapabilities URN -> account capability object, from the registered types
 */
function sessionCapabilities(limits, accountCapabilities) {
    const capabilities = {
        [URN.core]: {
            maxSizeUpload: limits.maxSizeUpload,
            maxConcurrentUpload: limits.maxConcurrentUpload,
            maxSizeRequest: limits.maxSizeRequest,
            maxConcurrentRequests: limits.maxConcurrentRequests,
            maxCallsInRequest: limits.maxCallsInRequest,
            maxObjectsInGet: limits.maxObjectsInGet,
            maxObjectsInSet: limits.maxObjectsInSet,
            collationAlgorithms: COLLATIONS
        }
    };
    for (const urn of Object.keys(accountCapabilities)) {
        // the session level object of the other capabilities carries nothing
        capabilities[urn] = {};
    }
    return capabilities;
}

module.exports = { URN, COLLATIONS, EMAIL_SORTS, DEFAULT_LIMITS, limitsFrom, sessionCapabilities };
