/* eslint no-invalid-this: 0, no-unused-expressions: 0 */

'use strict';

const fs = require('fs');
const os = require('os');
const Path = require('path');
const chai = require('chai');
const { createSuiteApp } = require('../../suite');
const { createInstallerState } = require('../../lib/suite/installer/state');
const { SESSION_COOKIE_NAME } = require('../../lib/suite/session');

const expect = chai.expect;

describe('HTMX Admin Console (Tasks 6 & 7)', () => {
    let tmpStateFile;
    let stateStore;

    beforeEach(() => {
        tmpStateFile = Path.join(os.tmpdir(), `wd-admin-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        stateStore = createInstallerState({ stateFile: tmpStateFile });
        stateStore.saveConfig({ mailDomain: 'corp.vn', hostname: 'mail.corp.vn' });
    });

    afterEach(() => {
        if (tmpStateFile && fs.existsSync(tmpStateFile)) {
            fs.unlinkSync(tmpStateFile);
        }
    });

    async function createAdminCookie(app, role = 'admin') {
        let created = await app.suiteSessions.createSession({
            userId: '507f191e810c19729de860ea',
            username: role === 'admin' ? 'sysadmin' : 'regularuser',
            role,
            accessToken: 'admin_tok_123'
        });
        return {
            cookie: `${SESSION_COOKIE_NAME}=${created.cookieValue}`,
            csrfToken: created.session.csrfToken
        };
    }

    describe('Admin Role Guard, Dashboard & Safe Upgrade UI (Task 6)', () => {
        it('blocks unauthenticated or non-admin users from accessing /admin/*', async () => {
            let app = await createSuiteApp({
                cookieSecret: 'admin-test-secret',
                installerState: stateStore
            });

            try {
                let anonRes = await app.inject({ method: 'GET', url: '/admin' });
                expect(anonRes.statusCode).to.equal(302);
                expect(anonRes.headers.location).to.include('/login');

                let userAuth = await createAdminCookie(app, 'user');
                let forbiddenRes = await app.inject({
                    method: 'GET',
                    url: '/admin',
                    headers: { cookie: userAuth.cookie }
                });
                expect(forbiddenRes.statusCode).to.equal(403);
            } finally {
                await app.close();
            }
        });

        it('renders Admin Dashboard with service health metrics and executes Safe Upgrade + Rollback', async () => {
            let fakeApi = {
                get: async path => {
                    if (path === '/health') {
                        return { success: true, mongodb: true, redis: true };
                    }
                    if (path === '/users') {
                        return { success: true, total: 14, results: [] };
                    }
                    if (path === '/dkim') {
                        return { success: true, total: 3, results: [] };
                    }
                    return { success: true, results: [] };
                },
                post: async () => ({ success: true }),
                put: async () => ({ success: true }),
                del: async () => ({ success: true })
            };

            let app = await createSuiteApp({
                cookieSecret: 'admin-test-secret',
                installerState: stateStore,
                apiClient: fakeApi
            });

            try {
                let adminAuth = await createAdminCookie(app, 'admin');

                let dashRes = await app.inject({
                    method: 'GET',
                    url: '/admin',
                    headers: { cookie: adminAuth.cookie }
                });
                expect(dashRes.statusCode).to.equal(200);
                expect(dashRes.body).to.include('1.55.1');
                expect(dashRes.body).to.include('14');

                let sysRes = await app.inject({
                    method: 'GET',
                    url: '/admin/system',
                    headers: {
                        cookie: adminAuth.cookie,
                        'hx-request': 'true'
                    }
                });
                expect(sysRes.statusCode).to.equal(200);
                expect(sysRes.body).to.include('1.55.1');

                let upgradeRes = await app.inject({
                    method: 'POST',
                    url: '/admin/system/upgrade',
                    headers: {
                        cookie: adminAuth.cookie,
                        'x-csrf-token': adminAuth.csrfToken,
                        'hx-request': 'true'
                    },
                    payload: { targetVersion: '1.55.1' }
                });
                expect(upgradeRes.statusCode).to.equal(200);
                expect(stateStore.load().snapshots.length).to.be.greaterThan(0);

                let rollbackRes = await app.inject({
                    method: 'POST',
                    url: '/admin/system/rollback',
                    headers: {
                        cookie: adminAuth.cookie,
                        'x-csrf-token': adminAuth.csrfToken,
                        'hx-request': 'true'
                    }
                });
                expect(rollbackRes.statusCode).to.equal(200);
            } finally {
                await app.close();
            }
        });
    });

    describe('Admin CRUD Flows: Users, Quotas, Aliases, Domains, DKIM, Certs & Audit (Task 7)', () => {
        it('manages users with localized folder languages, quotas, aliases, DKIM keys, certs, and auth logs via HTMX', async () => {
            let apiLog = [];
            let fakeApi = {
                get: async (path, opts) => {
                    apiLog.push({ method: 'GET', path, query: opts && opts.query });
                    if (path === '/users') {
                        return {
                            success: true,
                            total: 1,
                            results: [
                                {
                                    id: 'u100',
                                    username: 'nguyen',
                                    name: 'Nguyen Van A',
                                    address: 'nguyen@corp.vn',
                                    limits: { quota: { used: 10485760, allowed: 1073741824 } }
                                }
                            ]
                        };
                    }
                    if (path === '/users/u100') {
                        return {
                            success: true,
                            id: 'u100',
                            username: 'nguyen',
                            name: 'Nguyen Van A',
                            address: 'nguyen@corp.vn',
                            limits: {
                                quota: { used: 10485760, allowed: 1073741824 },
                                recipients: { allowed: 200 },
                                forwards: { allowed: 50 }
                            }
                        };
                    }
                    if (path === '/users/u100/addresses') {
                        return {
                            success: true,
                            results: [{ id: 'a1', address: 'nguyen@corp.vn', main: true }]
                        };
                    }
                    if (path === '/dkim') {
                        return {
                            success: true,
                            results: [
                                {
                                    id: 'dkim100',
                                    domain: 'corp.vn',
                                    selector: 'wd2026',
                                    fingerprint: 'AA:BB:CC',
                                    dnsTxt: { name: 'wd2026._domainkey.corp.vn', value: 'v=DKIM1; k=rsa; p=MIGfMA0' }
                                }
                            ]
                        };
                    }
                    if (path === '/domainaliases') {
                        return {
                            success: true,
                            results: [{ id: 'da1', domain: 'alias.corp.vn', alias: 'corp.vn' }]
                        };
                    }
                    if (path === '/certs') {
                        return {
                            success: true,
                            results: [{ id: 'cert1', servername: 'mail.corp.vn', subject: { commonName: 'mail.corp.vn' }, expires: '2027-01-01T00:00:00Z' }]
                        };
                    }
                    if (path === '/users/u100/authlog') {
                        return {
                            success: true,
                            results: [{ id: 'ev1', action: 'login', ip: '203.0.113.5', protocol: 'IMAP', success: true, created: '2026-10-21T10:00:00Z' }]
                        };
                    }
                    return { success: true, results: [] };
                },
                post: async (path, opts) => {
                    apiLog.push({ method: 'POST', path, body: opts && opts.body });
                    return { success: true, id: 'created123' };
                },
                put: async (path, opts) => {
                    apiLog.push({ method: 'PUT', path, body: opts && opts.body });
                    return { success: true };
                },
                del: async path => {
                    apiLog.push({ method: 'DELETE', path });
                    return { success: true };
                }
            };

            let app = await createSuiteApp({
                cookieSecret: 'admin-crud-secret',
                installerState: stateStore,
                apiClient: fakeApi
            });

            try {
                let adminAuth = await createAdminCookie(app, 'admin');
                let headers = {
                    cookie: adminAuth.cookie,
                    'x-csrf-token': adminAuth.csrfToken,
                    'hx-request': 'true'
                };

                // 1. List users
                let listUsers = await app.inject({ method: 'GET', url: '/admin/users', headers });
                expect(listUsers.statusCode).to.equal(200);
                expect(listUsers.body).to.include('nguyen@corp.vn');

                // 2. Create user with Vietnamese default folder language
                let createUser = await app.inject({
                    method: 'POST',
                    url: '/admin/users',
                    headers,
                    payload: {
                        username: 'tran',
                        name: 'Tran B',
                        password: 'Password123!',
                        address: 'tran@corp.vn',
                        quotaMb: '2048',
                        language: 'vi'
                    }
                });
                expect(createUser.statusCode).to.equal(200);
                let userPost = apiLog.find(c => c.method === 'POST' && c.path === '/users');
                expect(userPost.body.language).to.equal('vi');
                expect(userPost.body.quota).to.equal(2048 * 1024 * 1024);

                // 3. Edit user & add alias
                let editModal = await app.inject({ method: 'GET', url: '/admin/users/u100/edit', headers });
                expect(editModal.statusCode).to.equal(200);
                expect(editModal.body).to.include('Nguyen Van A');

                let updateUser = await app.inject({
                    method: 'POST',
                    url: '/admin/users/u100/update',
                    headers,
                    payload: { name: 'Nguyen Updated', quotaMb: '4096', recipients: '500', forwards: '100' }
                });
                expect(updateUser.statusCode).to.equal(200);
                expect(apiLog.some(c => c.method === 'PUT' && c.path === '/users/u100')).to.equal(true);

                let addAlias = await app.inject({
                    method: 'POST',
                    url: '/admin/users/u100/addresses',
                    headers,
                    payload: { address: 'sales@corp.vn' }
                });
                expect(addAlias.statusCode).to.equal(200);
                expect(apiLog.some(c => c.method === 'POST' && c.path === '/users/u100/addresses')).to.equal(true);

                // 4. Domains, DKIM & Domain Aliases
                let domainsRes = await app.inject({ method: 'GET', url: '/admin/domains', headers });
                expect(domainsRes.statusCode).to.equal(200);
                expect(domainsRes.body).to.include('wd2026._domainkey.corp.vn');

                let createDkim = await app.inject({
                    method: 'POST',
                    url: '/admin/domains/dkim',
                    headers,
                    payload: { domain: 'newdomain.vn', selector: 'wd2026' }
                });
                expect(createDkim.statusCode).to.equal(200);
                expect(apiLog.some(c => c.method === 'POST' && c.path === '/dkim')).to.equal(true);

                // 5. TLS Certificates & ACME
                let certsRes = await app.inject({ method: 'GET', url: '/admin/certs', headers });
                expect(certsRes.statusCode).to.equal(200);
                expect(certsRes.body).to.include('mail.corp.vn');

                let acmeRes = await app.inject({
                    method: 'POST',
                    url: '/admin/certs/acme',
                    headers,
                    payload: { domain: 'mail.corp.vn' }
                });
                expect(acmeRes.statusCode).to.equal(200);

                // 6. Audit & Auth Logs
                let auditRes = await app.inject({ method: 'GET', url: '/admin/audit?userId=u100', headers });
                expect(auditRes.statusCode).to.equal(200);
                expect(auditRes.body).to.include('203.0.113.5');
            } finally {
                await app.close();
            }
        });
    });
});
