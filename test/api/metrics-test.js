/* eslint no-invalid-this: 0 */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const config = require('@zone-eu/wild-config');

const expect = chai.expect;
const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Metrics API', function () {
    this.timeout(10000);

    it.only('should GET /metrics expect success without access token', async () => {
        await server.get('/health').expect(200);

        const response = await server.get('/metrics').expect(200);

        console.log(response.text);

        expect(response.headers['content-type']).to.match(/^text\/plain/);
        expect(response.text).to.include('# HELP wildduck_info');
        expect(response.text).to.match(/wildduck_info\{version="/);
        expect(response.text).to.include('wildduck_api_requests_total');
        expect(response.text).to.include('route="/health"');
    });
});
