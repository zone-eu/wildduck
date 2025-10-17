/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('API DomainAliases', function () {
    let domainalias;

    this.timeout(10000); // eslint-disable-line no-invalid-this

    it('should POST /domainaliases expect success', async () => {
        const response = await server
            .post('/domainaliases')
            .send({
                domain: 'example.com',
                alias: 'alias.example.com',
                sess: '12345',
                ip: '127.0.0.1'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(/^[0-9a-f]{24}$/.test(response.body.id)).to.be.true;
        domainalias = response.body.id;
    });

    it('should GET /domainaliases/:alias expect success', async () => {
        const response = await server.get(`/domainaliases/${domainalias}`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.equal(domainalias);
    });

    it('should GET /domainaliases/resolve/:alias expect success', async () => {
        const response = await server.get(`/domainaliases/resolve/alias.example.com`).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.equal(domainalias);
    });

    it('should GET /domainaliases expect success', async () => {
        const response = await server.get(`/domainaliases?query=alias.example.com`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.results.length).to.gte(1);
        expect(response.body.results.find(entry => entry.id === domainalias)).to.exist;
    });

    it('should DELETE /domainaliases/:alias expect success', async () => {
        const response = await server.delete(`/domainaliases/${domainalias}`).expect(200);

        expect(response.body.success).to.be.true;
    });
});
