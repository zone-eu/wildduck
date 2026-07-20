/* eslint no-invalid-this: 0 */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const Fs = require('fs');
const Path = require('path');
const config = require('@zone-eu/wild-config');
const metrics = require('../../lib/metrics');

const expect = chai.expect;
const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Metrics API', function () {
    this.timeout(10000);

    it('should leave metrics disabled by default', () => {
        const configContents = Fs.readFileSync(Path.resolve(__dirname, '../../config/api.toml'), 'utf8');
        const metricsSection = (configContents.match(/\[metrics\]([\s\S]*?)(?=\n\[|$)/) || [])[1] || '';

        expect(metricsSection).to.match(/(?:^|\n)enabled\s*=\s*false(?:\n|$)/);
    });

    it('should bound protocol command and message source labels', async () => {
        const imapCounter = metrics.register.getSingleMetric('wildduck_imap_commands_total');
        const imapDuration = metrics.register.getSingleMetric('wildduck_imap_command_duration_seconds');
        const pop3Counter = metrics.register.getSingleMetric('wildduck_pop3_commands_total');
        const pop3Duration = metrics.register.getSingleMetric('wildduck_pop3_command_duration_seconds');

        imapCounter.reset();
        imapDuration.reset();
        pop3Counter.reset();
        pop3Duration.reset();

        for (let i = 0; i < 100; i++) {
            metrics.recordImapCommand(`attacker-command-${i}`, `attacker-result-${i}`, 0.001);
            metrics.recordPop3Command(`attacker-command-${i}`, `attacker-result-${i}`, 0.001);
        }

        const imapValues = (await imapCounter.get()).values;
        const pop3Values = (await pop3Counter.get()).values;
        expect(imapValues).to.have.lengthOf(1);
        expect(imapValues[0]).to.include({ value: 100 });
        expect(imapValues[0].labels).to.deep.equal({ command: 'other', result: 'error' });
        expect(pop3Values).to.have.lengthOf(1);
        expect(pop3Values[0]).to.include({ value: 100 });
        expect(pop3Values[0].labels).to.deep.equal({ command: 'other', result: 'error' });

        expect(metrics.normalizeSource({ meta: { origin: '203.0.113.42' } })).to.equal('unknown');
        expect(metrics.normalizeSource({ meta: { transtype: 'a-user-controlled-value' } })).to.equal('unknown');
        expect(metrics.normalizeSource({ meta: { source: 'UPLOAD' } })).to.equal('api');
        expect(metrics.normalizeSource({ meta: { source: 'MX' } })).to.equal('lmtp');

        imapCounter.reset();
        imapDuration.reset();
        pop3Counter.reset();
        pop3Duration.reset();
    });

    it('should aggregate service readiness without summing workers', async () => {
        metrics.setServiceUp('api', true);
        const serviceGauge = metrics.register.getSingleMetric('wildduck_service_up');
        const workerOne = await serviceGauge.get();
        const workerTwo = JSON.parse(JSON.stringify(workerOne));
        const allReadyRegistry = metrics.client.AggregatorRegistry.aggregate([[workerOne], [workerTwo]]);
        const allReadyValues = (await allReadyRegistry.getSingleMetric('wildduck_service_up').get()).values;

        expect(allReadyValues.find(entry => entry.labels.service === 'api').value).to.equal(1);

        workerTwo.values.find(entry => entry.labels.service === 'api').value = 0;
        const oneUnreadyRegistry = metrics.client.AggregatorRegistry.aggregate([[workerOne], [workerTwo]]);
        const oneUnreadyValues = (await oneUnreadyRegistry.getSingleMetric('wildduck_service_up').get()).values;

        expect(oneUnreadyValues.find(entry => entry.labels.service === 'api').value).to.equal(0);
    });

    it('should GET /metrics expect success without access token', async () => {
        await server.get('/health').expect(200);

        const response = await server.get('/metrics').expect(200);

        expect(response.headers['content-type']).to.match(/^text\/plain/);
        expect(response.text).to.include('# HELP wildduck_info');
        expect(response.text).to.match(/wildduck_info\{version="/);
        expect(response.text).to.include('wildduck_api_requests_total');
        expect(response.text).to.include('route="/health"');
    });

    it('should cache expensive collector queries', async () => {
        expect(config.api.metrics.collectCacheTtl).to.equal(10000);

        let taskQueries = 0;
        let queueQueries = 0;

        metrics.registerTaskDatabase({
            collection(name) {
                expect(name).to.equal('tasks');
                return {
                    aggregate() {
                        taskQueries++;
                        return {
                            async toArray() {
                                return [{ _id: { type: 'quota', status: 'pending' }, count: 2 }];
                            }
                        };
                    }
                };
            }
        });
        metrics.registerBullQueue('test_queue', {
            async getJobCounts() {
                queueQueries++;
                return { waiting: 3 };
            }
        });

        const firstOutput = await metrics.getMetrics();
        const secondOutput = await metrics.getMetrics();

        expect(taskQueries).to.equal(1);
        expect(queueQueries).to.equal(1);
        expect(firstOutput).to.include('wildduck_tasks{type="quota",status="pending"} 2');
        expect(firstOutput).to.include('wildduck_bullmq_jobs{queue="test_queue",state="waiting"} 3');
        expect(secondOutput).to.include('wildduck_tasks{type="quota",status="pending"} 2');
        expect(secondOutput).to.include('wildduck_bullmq_jobs{queue="test_queue",state="waiting"} 3');
    });
});
