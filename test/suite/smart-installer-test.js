/* eslint no-invalid-this: 0, no-unused-expressions: 0 */

'use strict';

const fs = require('fs');
const os = require('os');
const Path = require('path');
const chai = require('chai');
const { createInstallerState } = require('../../lib/suite/installer/state');
const { runPreflightChecks } = require('../../lib/suite/installer/preflight');
const { buildRequiredDnsRecords, verifyDnsRecords } = require('../../lib/suite/installer/dns-verifier');
const { provisionSuiteStack } = require('../../lib/suite/installer/provisioner');
const { getUpgradeStatus, runSafeUpgrade } = require('../../lib/suite/installer/upgrader');
const { createSuiteApp } = require('../../suite');

const expect = chai.expect;

describe('Smart Installer (Tasks 4 & 5)', () => {
    let tmpStateFile;

    beforeEach(() => {
        tmpStateFile = Path.join(os.tmpdir(), `wd-suite-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    });

    afterEach(() => {
        if (tmpStateFile && fs.existsSync(tmpStateFile)) {
            fs.unlinkSync(tmpStateFile);
        }
    });

    describe('Idempotent State Machine & Snapshot Rollback (Task 4)', () => {
        it('persists step progress, resumes from failed step, and locks upon completion', () => {
            let store = createInstallerState({ stateFile: tmpStateFile });
            let initial = store.load();
            expect(initial.locked).to.equal(false);
            expect(initial.currentStep).to.equal(1);

            store.updateStep('language', 'completed', { locale: 'vi' });
            store.updateStep('preflight', 'completed');
            store.updateStep('provision', 'failed', { error: 'MongoDB timeout' });

            let reloaded = createInstallerState({ stateFile: tmpStateFile }).load();
            expect(reloaded.locale).to.equal('vi');
            expect(reloaded.steps.provision.status).to.equal('failed');
            expect(reloaded.steps.provision.error).to.equal('MongoDB timeout');
            expect(reloaded.resumeStep).to.equal(3);

            store.createSnapshot('1.55.1', { mailDomain: 'example.com', hostname: 'mail.example.com' });
            store.saveConfig({ mailDomain: 'broken.example.com' });

            let restored = store.restoreLatestSnapshot();
            expect(restored.config.mailDomain).to.equal('example.com');

            store.lock();
            expect(store.load().locked).to.equal(true);
        });
    });

    describe('System & Port Pre-flight Diagnostics (Task 4)', () => {
        it('evaluates hardware resources and port availability with pass/warn/fail statuses', async () => {
            let report = await runPreflightChecks({
                systemInfo: {
                    platform: 'linux',
                    release: '6.8.0-generic',
                    nodeVersion: 'v24.21.0',
                    totalMemBytes: 4 * 1024 * 1024 * 1024,
                    cpuCores: 4,
                    freeDiskBytes: 25 * 1024 * 1024 * 1024
                },
                portProbe: async port => port !== 25
            });

            expect(report.checks).to.be.an('array').with.length.greaterThan(4);
            let ramCheck = report.checks.find(c => c.id === 'ram');
            expect(ramCheck.status).to.equal('pass');

            let portCheck = report.checks.find(c => c.id === 'ports');
            expect(portCheck.status).to.equal('warn');
            expect(portCheck.occupiedPorts).to.deep.equal([25]);
        });
    });

    describe('Live DNS, DKIM, SPF, DMARC & PTR Verifier (Task 4)', () => {
        it('generates required records and verifies live DNS responses', async () => {
            let params = {
                mailDomain: 'example.com',
                hostname: 'mail.example.com',
                publicIp: '203.0.113.10',
                dkimSelector: 'wd2026',
                dkimPublicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A'
            };

            let records = buildRequiredDnsRecords(params);
            expect(records).to.have.lengthOf(6);

            let verified = await verifyDnsRecords(params, {
                resolve4: async host => (host === 'mail.example.com' ? ['203.0.113.10'] : []),
                resolveMx: async domain => (domain === 'example.com' ? [{ exchange: 'mail.example.com.', priority: 10 }] : []),
                resolveTxt: async name => {
                    if (name === 'example.com') {
                        return [['v=spf1 mx a:mail.example.com -all']];
                    }
                    if (name === 'wd2026._domainkey.example.com') {
                        return [['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A']];
                    }
                    if (name === '_dmarc.example.com') {
                        return [['v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com']];
                    }
                    return [];
                },
                reverse: async ip => (ip === '203.0.113.10' ? ['mail.example.com'] : [])
            });

            expect(verified.allPassed).to.equal(true);
            for (let rec of verified.records) {
                expect(rec.status).to.equal('pass');
            }
        });
    });

    describe('Zero-Config Provisioner & Safe Upgrader (Task 5)', () => {
        it('provisions domain, admin account, and RSA DKIM key without manual config editing', async () => {
            let apiCalls = [];
            let fakeApi = {
                post: async (path, opts) => {
                    apiCalls.push({ path, body: opts.body });
                    if (path === '/dkim') {
                        return {
                            success: true,
                            id: 'dkim1',
                            selector: 'wd2026',
                            publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA',
                            dnsTxt: { value: 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' }
                        };
                    }
                    if (path === '/users') {
                        return { success: true, id: '507f191e810c19729de860ea' };
                    }
                    return { success: true };
                }
            };

            let result = await provisionSuiteStack(
                {
                    mailDomain: 'company.vn',
                    hostname: 'mail.company.vn',
                    adminUsername: 'admin',
                    adminPassword: 'StrongPassword123!',
                    locale: 'vi',
                    dkimSelector: 'wd2026'
                },
                fakeApi
            );

            expect(result.success).to.equal(true);
            expect(result.mailDomain).to.equal('company.vn');
            expect(result.adminAddress).to.equal('admin@company.vn');
            expect(result.dkimPublicKey).to.be.a('string').with.length.greaterThan(16);
            expect(apiCalls.some(c => c.path === '/dkim')).to.equal(true);
            expect(apiCalls.some(c => c.path === '/users' && c.body.language === 'vi')).to.equal(true);
        });

        it('creates a snapshot before upgrade and rolls back automatically if migration fails', async () => {
            let stateStore = createInstallerState({ stateFile: tmpStateFile });
            stateStore.saveConfig({ mailDomain: 'stable.vn', hostname: 'mail.stable.vn' });

            let statusBefore = getUpgradeStatus(stateStore);
            expect(statusBefore.currentVersion).to.equal('1.55.1');

            let failedUpgrade = await runSafeUpgrade({
                installerState: stateStore,
                targetVersion: '1.56.0',
                migrationRunner: async () => {
                    stateStore.saveConfig({ mailDomain: 'corrupted-during-upgrade.vn' });
                    throw new Error('Index migration conflict');
                }
            });

            expect(failedUpgrade.success).to.equal(false);
            expect(failedUpgrade.rolledBack).to.equal(true);
            expect(stateStore.load().config.mailDomain).to.equal('stable.vn');

            let okUpgrade = await runSafeUpgrade({
                installerState: stateStore,
                targetVersion: '1.56.0',
                migrationRunner: async () => true
            });
            expect(okUpgrade.success).to.equal(true);
            expect(stateStore.load().version).to.equal('1.56.0');
        });
    });

    describe('5-Step HTMX Web Setup Wizard E2E Flow (Task 5)', () => {
        it('walks through language -> preflight -> provision -> live DNS check -> lock', async () => {
            let stateStore = createInstallerState({ stateFile: tmpStateFile });
            let app = await createSuiteApp({
                cookieSecret: 'wizard-test-secret',
                installerState: stateStore,
                setupToken: 'init-token-123',
                dnsResolver: {
                    resolve4: async () => ['127.0.0.1'],
                    resolveMx: async () => [{ exchange: 'mail.example.vn', priority: 10 }],
                    resolveTxt: async () => [['v=spf1 mx a:mail.example.vn -all', 'v=DKIM1; k=rsa; p=', 'v=DMARC1; p=quarantine']],
                    reverse: async () => ['mail.example.vn']
                }
            });

            try {
                // Step 1: Open wizard with setup token and choose Vietnamese
                let step1 = await app.inject({
                    method: 'GET',
                    url: '/setup?token=init-token-123'
                });
                expect(step1.statusCode).to.equal(200);
                expect(step1.body).to.include('1.55.1');

                let chooseLang = await app.inject({
                    method: 'POST',
                    url: '/setup/language',
                    headers: { 'hx-request': 'true' },
                    payload: { lang: 'vi', token: 'init-token-123' }
                });
                expect(chooseLang.statusCode).to.equal(200);
                expect(stateStore.load().locale).to.equal('vi');

                // Step 2: Run pre-flight check
                let preflightRes = await app.inject({
                    method: 'POST',
                    url: '/setup/preflight',
                    headers: { 'hx-request': 'true' },
                    payload: { token: 'init-token-123' }
                });
                expect(preflightRes.statusCode).to.equal(200);
                expect(stateStore.load().steps.preflight.status).to.equal('completed');

                // Step 3: Provision domain & admin account
                let provisionRes = await app.inject({
                    method: 'POST',
                    url: '/setup/provision',
                    headers: { 'hx-request': 'true' },
                    payload: {
                        token: 'init-token-123',
                        mailDomain: 'example.vn',
                        hostname: 'mail.example.vn',
                        publicIp: '127.0.0.1',
                        adminUsername: 'admin',
                        adminPassword: 'SecretPassword123!'
                    }
                });
                expect(provisionRes.statusCode).to.equal(200);
                expect(provisionRes.headers['hx-trigger']).to.match(/^[\x20-\x7e]+$/);
                expect(JSON.parse(provisionRes.headers['hx-trigger']).showToast).to.include('Đã khởi tạo cấu hình dịch vụ');
                expect(stateStore.load().config.mailDomain).to.equal('example.vn');
                expect(stateStore.load().steps.provision.status).to.equal('completed');

                // Step 4: Verify DNS records live via HTMX
                let dnsRes = await app.inject({
                    method: 'POST',
                    url: '/setup/verify-dns',
                    headers: { 'hx-request': 'true' },
                    payload: { token: 'init-token-123' }
                });
                expect(dnsRes.statusCode).to.equal(200);
                expect(dnsRes.body).to.include('mail.example.vn');
                expect(stateStore.load().steps.dns.status).to.equal('completed');

                // Step 5: Finalize and lock wizard
                let finalizeRes = await app.inject({
                    method: 'POST',
                    url: '/setup/finalize',
                    headers: { 'hx-request': 'true' },
                    payload: { token: 'init-token-123' }
                });
                expect(finalizeRes.statusCode).to.equal(200);
                expect(stateStore.load().locked).to.equal(true);

                // Subsequent unauthenticated access to /setup must be locked (403)
                let lockedRes = await app.inject({
                    method: 'GET',
                    url: '/setup'
                });
                expect(lockedRes.statusCode).to.equal(403);
            } finally {
                await app.close();
            }
        });
    });
});
