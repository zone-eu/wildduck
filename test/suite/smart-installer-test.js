/* eslint no-invalid-this: 0, no-unused-expressions: 0 */

'use strict';

const fs = require('fs');
const os = require('os');
const Path = require('path');
const chai = require('chai');
const { createInstallerState } = require('../../lib/suite/installer/state');
const { runPreflightChecks } = require('../../lib/suite/installer/preflight');
const { buildRequiredDnsRecords, verifyDnsRecords } = require('../../lib/suite/installer/dns-verifier');

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
});
