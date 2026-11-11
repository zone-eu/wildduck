'use strict';

// GET /jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping} (RFC 8620 7.3)
//
// Listens to the account's change notifications (ImapNotifier, fanned out across workers through Redis)
// and pushes a StateChange whenever a state of a requested type moved. The event id is the journal
// anchor, so a client reconnecting with Last-Event-ID gets an event only if something changed since.

const { RequestProblem } = require('../errors');

const DEFAULTS = { minPing: 5, maxPing: 300, maxDuration: 1800 };

function parseParams(query, pushTypes, limits) {
    const types = typeof query.types === 'string' ? query.types : '';
    const requested = types === '*' ? pushTypes : types.split(',').filter(Boolean);
    if (!requested.length || requested.some(type => !pushTypes.includes(type))) {
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

module.exports = ({ route, context, deps, registry, options }) => {
    const limits = Object.assign({}, DEFAULTS, options.eventSource || {});
    const pushModules = registry.modules.filter(module => module.pushStates);
    const pushTypes = pushModules.flatMap(module => module.pushTypes);

    // states of every push type for the account: {Email: '...', Mailbox: '...', ...}
    const currentStates = async requestContext => {
        requestContext.cache = {};
        const parts = await Promise.all(pushModules.map(module => module.pushStates(requestContext)));
        return Object.assign({}, ...parts);
    };

    route('/jmap/eventsource', ['GET'], eventSource);
    route('/jmap/eventsource/', ['GET'], eventSource);

    async function eventSource(request, reply) {
        const params = parseParams(request.query, pushTypes, limits);
        const requestContext = context(request, { capabilities: {}, state: null });
        const accountId = requestContext.account.id;

        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-store',
            'X-Accel-Buffering': 'no',
            Connection: 'keep-alive'
        });
        // a comment line flushes the headers through proxies
        res.write(': connected\n\n');

        let lastStates = await currentStates(requestContext);
        let lastId = lastStates.Email ? lastStates.Email.slice(0, 24) : null;
        let closed = false;
        let pingTimer = null;
        let maxTimer = null;
        let checking = Promise.resolve();
        // set below; close() removes it from the notifier
        let onChange = null;

        const schedulePing = () => {
            clearTimeout(pingTimer);
            if (params.ping) {
                pingTimer = setTimeout(() => {
                    res.write(`event: ping\ndata: ${JSON.stringify({ interval: params.ping })}\n\n`);
                    schedulePing();
                }, params.ping * 1000);
            }
        };

        const session = { id: `jmap-es-${request.id}`, user: { id: requestContext.account.user, username: requestContext.account.userData.username } };
        const close = () => {
            if (closed) {
                return;
            }
            closed = true;
            clearTimeout(pingTimer);
            clearTimeout(maxTimer);
            deps.notifier.removeListener(session, onChange);
            res.end();
        };

        // pushes the requested types whose state differs from the last pushed one
        const push = (states, force) => {
            const changed = {};
            for (const [type, state] of Object.entries(states)) {
                if (params.types.has(type) && (force || state !== lastStates[type])) {
                    changed[type] = state;
                }
            }
            lastStates = states;
            if (!Object.keys(changed).length) {
                return;
            }
            lastId = states.Email ? states.Email.slice(0, 24) : lastId;
            res.write(`event: state\nid: ${lastId}\ndata: ${JSON.stringify({ '@type': 'StateChange', changed: { [accountId]: changed } })}\n\n`);
            schedulePing();
            if (params.closeAfterState) {
                close();
            }
        };

        onChange = () => {
            checking = checking.then(async () => {
                if (!closed) {
                    push(await currentStates(requestContext), false);
                }
            });
            checking.catch(() => false);
        };

        maxTimer = setTimeout(close, limits.maxDuration * 1000);
        request.raw.once('close', close);
        deps.notifier.addListener(session, onChange);
        schedulePing();

        // a reconnecting client that missed changes gets their states at once
        const lastEventId = request.headers['last-event-id'];
        if (lastEventId && lastEventId !== lastId) {
            push(lastStates, true);
        }
    }
};
