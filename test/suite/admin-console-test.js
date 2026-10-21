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
});
