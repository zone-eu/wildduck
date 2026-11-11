'use strict';

// GET /jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping} (RFC 8620 7.3)
//
// Listens to the account's change notifications (ImapNotifier, fanned out across workers through Redis)
// and pushes a StateChange whenever a state of a requested type moved. A stream costs one notifier
// listener and reads the states only when a notification arrives, never on a timer.
//
// The event id is the Email state string: it names the journal anchor, which covers every type pushed
// so far (Email, Mailbox and Thread share it, EmailDelivery is an older or equal journal entry), and it
// carries the account checksum, so an id of another account is not taken for one of this account.
// A client reconnecting with Last-Event-ID gets one event for the types that changed since, or for
// every requested type when the id is unknown or older than the journal retention.

const log = require('npmlog');
const { RequestProblem } = require('../errors');
const { parseState } = require('../state');

const DEFAULTS = { minPing: 5, maxPing: 300, maxDuration: 1800, maxStreams: 15, retryAfter: 30 };
const LIMIT_KEY = 'lim:jmap-eventsource';

// Type names of the capabilities WildDuck implements in later phases. They are accepted in `types`
// so a client may ask for them, and are pushed once their module declares push states.
const RESERVED_TYPES = [
    'Identity',
    'EmailSubmission',
    'VacationResponse',
    'PushSubscription',
    'Quota',
    'AddressBook',
    'ContactCard',
    'Calendar',
    'CalendarEvent',
    'ParticipantIdentity',
    'CalendarEventNotification'
];

/**
 * The effective event source limits. RFC 8620 7.3: the minimum ping must not be above 30 seconds and
 * the maximum not below 300, so clients can rely on both values; anything else is refused at start up.
 */
function eventSourceLimits(configured) {
    const limits = Object.assign({}, DEFAULTS, configured || {});
    if (!(limits.minPing >= 1 && limits.minPing <= 30 && limits.maxPing >= 300 && limits.maxPing >= limits.minPing)) {
        throw new Error('jmap.eventSource: minPing must be between 1 and 30 and maxPing at least 300');
    }
    if (!(limits.maxStreams >= 1 && limits.maxDuration >= 1)) {
        throw new Error('jmap.eventSource: maxStreams and maxDuration must be positive');
    }
    return limits;
}

function parseParams(query, knownTypes, pushTypes, limits) {
    const types = typeof query.types === 'string' ? query.types : '';
    const requested = types === '*' ? pushTypes : types.split(',');
    if (!requested.length || requested.some(type => !knownTypes.has(type))) {
        throw new RequestProblem('about:blank', 400, 'types must be * or a list of known type names');
    }
    if (!['state', 'no'].includes(query.closeafter)) {
        throw new RequestProblem('about:blank', 400, 'closeafter must be state or no');
    }
    if (!/^\d{1,6}$/.test(query.ping || '')) {
        throw new RequestProblem('about:blank', 400, 'ping must be a number of seconds');
    }
    const ping = Number(query.ping);
    return {
        types: new Set(requested),
        closeAfterState: query.closeafter === 'state',
        // RFC 8620 7.3: 0 means no pings, other values are clamped to what the server allows
        ping: ping === 0 ? 0 : Math.min(Math.max(ping, limits.minPing), limits.maxPing)
    };
}

// The journal anchor (24 hex) in a state string of the mail types
const anchorOf = state => (typeof state === 'string' ? state.slice(0, 24) : '');

/**
 * The types to replay for a reconnecting client: every requested type whose state moved past the
 * anchor of the event id, or every type when the id is not a usable state of this account.
 */
function replayTypes(requestContext, lastEventId, states, retention) {
    let since = null;
    try {
        since = parseState(requestContext, lastEventId);
    } catch {
        // garbage, or an id of another account: unknown
    }
    if (!since || since.getTimestamp().getTime() < Date.now() - retention) {
        return Object.keys(states);
    }
    const anchor = since.toString();
    return Object.keys(states).filter(type => anchorOf(states[type]) > anchor);
}

function acquireStream(notifier, user, limit) {
    return new Promise((resolve, reject) => {
        notifier.counters.limitedcounter(LIMIT_KEY, user, 1, limit, (err, res) => (err ? reject(err) : resolve(res.success)));
    });
}

function releaseStream(notifier, user) {
    notifier.counters.limitedcounter(LIMIT_KEY, user, -1, 0, () => false);
}

module.exports = ({ route, context, deps, registry, options, auth }) => {
    const limits = eventSourceLimits(options.eventSource);
    const timers = deps.timers || { setTimeout, clearTimeout };
    const pushModules = registry.modules.filter(module => module.pushStates);
    const pushTypes = pushModules.flatMap(module => module.pushTypes);
    const knownTypes = new Set(pushTypes.concat(RESERVED_TYPES));

    // states of the push types a stream asked for, from the modules that have them: {Email: '...', ...}.
    // The Email state is always read, it is the event id
    const currentStates = async (requestContext, types) => {
        requestContext.cache = {};
        const modules = pushModules.filter(module => module.pushTypes.some(type => type === 'Email' || types.has(type)));
        const parts = await Promise.all(modules.map(module => module.pushStates(requestContext)));
        return Object.assign({}, ...parts);
    };

    route('/jmap/eventsource', ['GET'], eventSource);
    route('/jmap/eventsource/', ['GET'], eventSource);

    async function eventSource(request, reply) {
        const params = parseParams(request.query, knownTypes, pushTypes, limits);
        const requestContext = context(request, { capabilities: {}, state: null });
        const accountId = requestContext.account.id;
        const userId = requestContext.account.user.toString();
        // the application password the stream was opened with, if any
        const asp = requestContext.account.userData.authAsp || null;

        if (!(await acquireStream(deps.notifier, userId, limits.maxStreams))) {
            reply.header('Retry-After', String(limits.retryAfter));
            throw new RequestProblem('limit', 429, `More than ${limits.maxStreams} event source connections`);
        }

        const res = reply.raw;
        let closed = false;
        let pingTimer = null;
        let maxTimer = null;
        let checking = Promise.resolve();
        let lastStates = null;
        // set below; close() removes it from the notifier
        let onChange = null;
        const session = { id: `jmap-es-${request.id}`, user: { id: requestContext.account.user, username: requestContext.account.userData.username } };

        const close = () => {
            if (closed) {
                return;
            }
            closed = true;
            timers.clearTimeout(pingTimer);
            timers.clearTimeout(maxTimer);
            if (onChange) {
                deps.notifier.removeListener(session, onChange);
            }
            releaseStream(deps.notifier, userId);
            res.end();
        };
        // the response closes when the client goes away, and after close() ended it
        res.once('close', close);

        reply.hijack();
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-store',
            'X-Accel-Buffering': 'no',
            Connection: 'keep-alive'
        });

        const schedulePing = () => {
            timers.clearTimeout(pingTimer);
            if (params.ping && !closed) {
                pingTimer = timers.setTimeout(() => {
                    if (!closed) {
                        res.write(`event: ping\ndata: ${JSON.stringify({ interval: params.ping })}\n\n`);
                        schedulePing();
                    }
                }, params.ping * 1000);
            }
        };

        // pushes the requested types of `types` (all that differ from the last pushed states when not given)
        const push = (states, types) => {
            const changed = {};
            for (const [type, state] of Object.entries(states)) {
                if (params.types.has(type) && (types ? types.includes(type) : state !== lastStates[type])) {
                    changed[type] = state;
                }
            }
            lastStates = states;
            if (closed || !Object.keys(changed).length) {
                return;
            }
            res.write(`event: state\nid: ${states.Email}\ndata: ${JSON.stringify({ '@type': 'StateChange', changed: { [accountId]: changed } })}\n\n`);
            schedulePing();
            if (params.closeAfterState) {
                close();
            }
        };

        // the credentials of the stream were revoked: the account password changed, the account was
        // disabled, the application password was deleted, the jmap scope was disabled or the user deleted
        const revoked = async message => {
            if (message.command === 'LOGOUT') {
                return true;
            }
            if (message.command === 'ASPDELETE') {
                return !!asp && message.asp === asp;
            }
            if (message.command === 'CREDENTIALS') {
                return !(await auth.usableUser(userId));
            }
            return false;
        };

        // steps run one at a time, in order; a failing step ends the stream and the client reconnects
        // with its last event id, so nothing is lost
        const enqueue = step => {
            checking = checking
                .then(() => (closed ? null : step()))
                .catch(err => {
                    log.error('JMAP', 'request=%s eventsource error=%s', request.id, err.stack || err.message);
                    close();
                });
        };

        onChange = message =>
            enqueue(async () => {
                if (!message) {
                    return push(await currentStates(requestContext, params.types));
                }
                if (await revoked(message)) {
                    close();
                }
            });

        maxTimer = timers.setTimeout(close, limits.maxDuration * 1000);
        // listening starts before the first read, so a change made in between is not missed
        deps.notifier.addListener(session, onChange);
        schedulePing();

        enqueue(async () => {
            lastStates = await currentStates(requestContext, params.types);
            // a comment line flushes the headers through proxies. It is written once the stream is
            // listening and has its baseline, so every change after it is pushed
            res.write(': connected\n\n');
            // a reconnecting client that missed changes gets their states at once
            const lastEventId = request.headers['last-event-id'];
            if (lastEventId !== undefined && lastEventId !== lastStates.Email) {
                const { retention } = await requestContext.cache.anchors;
                push(lastStates, replayTypes(requestContext, lastEventId, lastStates, retention));
            }
        });
    }
};

module.exports.eventSourceLimits = eventSourceLimits;
