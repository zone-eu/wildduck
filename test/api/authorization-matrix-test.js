/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

// Role x route authorization matrix, in-process with app.inject().
//
// What a role may do is declared once, in config/roles.json, and every route
// handler states which grant it needs with roles.can(req.role).<action>(<resource>).
// For every route and every role this test derives the expected verdict from
// those two sources, sends a request that passes validation, and compares:
//
//   - a role that holds none of the grants the handler checks must get
//     403 MissingPrivileges, before the handler touches any data
//   - a role that holds all of them must get past the check
//
// Requests by a user scoped role (user, webmail, mcp:read) target the records
// of another user, the cross-tenant case, and in a second pass the role's own
// records. The other roles act as "root" tokens on the other user. Routes
// without a user in the path (listings, who-am-i) serve a user scoped role its
// own records, so there no reply to such a role may contain anything that
// identifies the other user.

const chai = require('chai');
const AccessControl = require('accesscontrol');
const config = require('@zone-eu/wild-config');
const { buildApp } = require('./_inprocess');
const { createFixtures } = require('./_fixtures');
const { createRoleToken, deleteRoleToken } = require('./_helpers');
const { createRandom, buildRequest, toInject, routeKey } = require('./_route-requests');

const expect = chai.expect;

const ac = new AccessControl();
ac.setGrants(config.api.roles);

// roles whose tokens belong to a user account, the others are issued to "root"
const USER_SCOPED_ROLES = ['user', 'webmail', 'mcp:read'];

// roles that only hold :own grants: their tokens must never see another account.
// webmail holds :any grants, it is a service role that acts for every account
const TENANT_ROLES = Object.keys(config.api.roles).filter(role =>
    Object.values(config.api.roles[role]).every(grants => Object.keys(grants).every(grant => grant.endsWith(':own')))
);

// routes that serve only tokens issued at login, whatever the grants of the role
const LOGIN_TOKEN_ROUTES = new Set(['POST /authenticate/:scope', 'DELETE /authenticate/:scope/:token']);

// the refusals of a permission check; other 403 codes come from handler logic
const DENIAL_CODES = new Set(['MissingPrivileges', 'MasterTokenRequired']);

// routes that legitimately check no role: they are public, only report the
// service state, or only act on the token that made the request
const UNCHECKED_ROUTES = ['GET /.well-known/acme-challenge/:token', 'GET /health', 'DELETE /authenticate'];

// routes that change state beyond the fixture records, or stream: only the
// requests that must be refused are sent
const DENY_ONLY_ROUTES = new Set([
    'POST /settings/:key',
    'DELETE /settings/:key',
    'PUT /addresses/renameDomain',
    'DELETE /users/:user',
    'POST /webhooks',
    'GET /users/:user/updates',
    'POST /data/export',
    'POST /data/import'
]);

// the permission checks a handler makes: [{action: 'readAny', resource: 'users'}, ...]
const permissionChecks = route =>
    [...route.handler.toString().matchAll(/roles\.can\(\s*req\.role\s*\)\.(\w+)\(\s*'([\w:]+)'\s*\)/g)].map(match => ({
        action: match[1],
        resource: match[2]
    }));

/**
 * allow, deny or null (the handler checks grants of which the role holds only
 * some, the verdict depends on the request and is not predicted)
 */
const expectedVerdict = (role, checks, ownRecords) => {
    const scope = ownRecords ? 'Own' : 'Any';
    // handlers that check both forms pick the Own one for the token's own records
    let applicable = checks.filter(check => check.action.endsWith(scope));
    if (!applicable.length) {
        applicable = checks;
    }
    const granted = applicable.map(check => ac.can(role)[check.action](check.resource).granted);
    if (granted.every(Boolean)) {
        return 'allow';
    }
    if (!granted.some(Boolean)) {
        return 'deny';
    }
    return null;
};

const observedVerdict = res => {
    let body = {};
    try {
        body = res.json();
    } catch {
        // not JSON: a download or a stream got past the check
    }
    if (res.statusCode === 403 && body.code === 'InvalidToken') {
        return 'token-rejected';
    }
    if (res.statusCode === 403 && DENIAL_CODES.has(body.code)) {
        return 'deny';
    }
    if (res.statusCode === 400 && body.code === 'InputValidationError') {
        // refused before the handler ran: says nothing about the permission check
        return 'not-reached';
    }
    return 'allow';
};

describe('API authorization matrix', function () {
    this.timeout(10 * 60 * 1000); // eslint-disable-line no-invalid-this

    let app;
    let routes;
    let actor; // the user the user scoped tokens belong to
    let victim; // the user whose records the cross-tenant requests target
    const roles = Object.keys(config.api.roles).filter(role => role !== 'root');

    before(async () => {
        ({ app, routes } = await buildApp());
        actor = await createFixtures(app, 'aa');
        victim = await createFixtures(app, 'av');
    });

    after(async () => {
        for (const fixtures of [actor, victim]) {
            if (fixtures) {
                await fixtures.cleanup();
            }
        }
        if (app) {
            await app.close();
        }
    });

    it('declares a permission check in every non-public route handler', () => {
        const unchecked = routes.filter(route => !permissionChecks(route).length).map(routeKey);
        expect(unchecked.sort()).to.deep.equal([...UNCHECKED_ROUTES].sort());
    });

    const runMatrix = async ({ ownRecords }) => {
        const failures = [];
        const counts = { allow: 0, deny: 0, unpredicted: 0, notReached: 0 };

        // the deleting requests go last, a wrongly granted one must not hide later results
        const ordered = [...routes].sort((a, b) => (a.method === 'DELETE') - (b.method === 'DELETE'));

        for (const role of roles) {
            if (ownRecords && !USER_SCOPED_ROLES.includes(role)) {
                continue;
            }
            const tokenUser = USER_SCOPED_ROLES.includes(role) ? actor.ids.user : undefined;

            for (const route of ordered) {
                const checks = permissionChecks(route);
                if (!checks.length) {
                    continue;
                }

                // routes without a user in the path act on the token's own account
                const ownScope = ownRecords || (USER_SCOPED_ROLES.includes(role) && !route.url.includes(':user'));
                const expected = LOGIN_TOKEN_ROUTES.has(routeKey(route)) && role !== 'user' ? 'deny' : expectedVerdict(role, checks, ownScope);
                if (!expected) {
                    counts.unpredicted++;
                    continue;
                }
                if (expected === 'allow' && DENY_ONLY_ROUTES.has(routeKey(route))) {
                    continue;
                }

                const fixtures = ownRecords ? actor : victim;
                const request = buildRequest(route, { rnd: createRandom(1), fixtures, optionalChance: 0 });
                if (!ownRecords && Object.hasOwn(request.params, 'user')) {
                    // user given in the query or body (webhooks, audit)
                    request.params.user = victim.ids.user;
                }

                // a fresh token per request: some allowed requests end the session
                // they were made with (logout, password reset of the own account)
                const { accessToken, tokenHash } = await createRoleToken(role, tokenUser);
                const res = await app.inject(toInject(route, request, { token: accessToken }));
                await deleteRoleToken(tokenHash);
                const observed = observedVerdict(res);

                if (observed === 'not-reached') {
                    counts.notReached++;
                    continue;
                }
                if (observed !== expected) {
                    failures.push(`${role} ${routeKey(route)}: expected ${expected}, got ${res.statusCode} ${res.body.slice(0, 120)}`);
                    continue;
                }
                if (!ownRecords && observed === 'allow' && TENANT_ROLES.includes(role)) {
                    const leaked = [victim.ids.user, victim.email, victim.username].filter(value => res.body.includes(value));
                    if (leaked.length) {
                        failures.push(`${role} ${routeKey(route)}: reply contains the other user's ${leaked.join(', ')}`);
                        continue;
                    }
                }
                counts[expected]++;
            }
        }

        return { failures, counts };
    };

    it('refuses other users records to user scoped roles and enforces every role on every route', async () => {
        const { failures, counts } = await runMatrix({ ownRecords: false });
        expect(failures, failures.join('\n')).to.deep.equal([]);
        // the generated requests must reach the checks, not stop at validation
        expect(counts.deny, JSON.stringify(counts)).to.be.greaterThan(1000);
        expect(counts.allow, JSON.stringify(counts)).to.be.greaterThan(100);
    });

    it('lets user scoped roles reach their own records', async () => {
        const { failures, counts } = await runMatrix({ ownRecords: true });
        expect(failures, failures.join('\n')).to.deep.equal([]);
        expect(counts.allow, JSON.stringify(counts)).to.be.greaterThan(50);
    });
});
