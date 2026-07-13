/* eslint no-invalid-this: 0 */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const config = require('@zone-eu/wild-config');
const metrics = require('../../lib/metrics');

const expect = chai.expect;
const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Metrics API', function () {
    this.timeout(10000);

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
