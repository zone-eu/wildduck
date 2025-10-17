/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('API DKIM', function () {
    let dkim;

    this.timeout(10000); // eslint-disable-line no-invalid-this

    it('should POST /dkim expect success / key empty', async () => {
        const response = await server
            .post('/dkim')
            .send({
                domain: 'example.com',
                selector: 'wildduck',
                description: 'Some text about this DKIM certificate',
                sess: '12345',
                ip: '127.0.0.1'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(/^[0-9a-f]{24}$/.test(response.body.id)).to.be.true;
        dkim = response.body.id;
        expect(response.body.dnsTxt.value).to.not.be.undefined;
        expect(response.body.dnsTxt.value.split('p=').length).to.be.equal(2); // check that splitting is correct
        expect(response.body.dnsTxt.value.split('p=')[1]).to.be.not.empty; // check that we actually have the key part and it is not an empty string
    });

    it('should POST /dkim expect success / RSA pem', async () => {
        const response = await server
            .post('/dkim')
            .send({
                domain: 'example.com',
                selector: 'wildduck',
                privateKey:
                    '-----BEGIN RSA PRIVATE KEY-----\nMIICXQIBAAKBgQDFCPszabID2MLAzzfja3/TboKp4dHUGSkl6hNSly7IRdAhfh6J\nh6vNa+2Y7pyNagX00ukycZ/03O/93X3UxjzX/NpLESo3GwSjp39R4AgdW91nKt7X\nzGoz4ZQELAao+AH1QhJ8vumXFLFc6sS9l7Eu3+cZcAdWij2TCPKrB56tMQIDAQAB\nAoGAAQNfz07e1Hg74CPwpKG74Yly8I6xtoZ+mKxQdx9B5VO+kz2DyK9C6eaBLUUk\n1vFRoIWpH1JIQUkVjtehuwNd8rgPacPZRjSJrGuvwtP/bjzA8m/z/lI0+rfQW7L7\nRfPoi2fl6MJ3KkjNypmVPPNvtJA42aPUDW6SFcXFvSv43gECQQD12RFLlZ5H3W6z\n2ncJXiZha508LoyABkYeb+veCFwicoNEreQrToDgC3GuBRkODsUgRZaVu2sa4tlv\nzO0rwkXRAkEAzSvmAxTvkSf/gMy5mO+sZKeUEtMHibF4LKxw7Men2oADgVTnS38r\nf8uYJteLt3lkfHfV5ezEOERvQutKnMfpYQJBAL7apceUvkyyBWfQWIrIMWl9vpHi\n3SXiOPsWDfjPap8/YNKnYDOSfQ/xMm5S/NFh+/yCqVVSKuKzavOVFiXbapECQQDC\nhWdK7rN/xRNaUz93/2xL9hHOkyNnacoNWOSrqVO8NnicSxoLmyNrw2SbFusRZdde\npuM2XfdffYqbQKd545OhAkBiCm/hUl5+hCJI6xl4wh3aR4h8j/TA6/u4ohPjqYco\nLUPpKBaWeKdwQRbkkpMsVz6lFtpyZlV6V8joGEd8OLMO\n-----END RSA PRIVATE KEY-----',
                description: 'Some text about this DKIM certificate',
                sess: '12345',
                ip: '127.0.0.1'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(/^[0-9a-f]{24}$/.test(response.body.id)).to.be.true;
        dkim = response.body.id;
    });

    it('should POST /dkim expect success / ED25519 pem', async () => {
        const response = await server
            .post('/dkim')
            .send({
                domain: 'example.com',
                selector: 'wildduck',
                privateKey: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIOQu92qofG/p0yAHDTNAawKchxOf/3MpDiPaCPk2xSPg\n-----END PRIVATE KEY-----',
                description: 'Some text about this DKIM certificate',
                sess: '12345',
                ip: '127.0.0.1'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(/^[0-9a-f]{24}$/.test(response.body.id)).to.be.true;
        dkim = response.body.id;
    });

    it('should POST /dkim expect success / ED25519 raw', async () => {
        const response = await server
            .post('/dkim')
            .send({
                domain: 'example.com',
                selector: 'wildduck',
                privateKey: 'nWGxne/9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A=',
                description: 'Some text about this DKIM certificate',
                sess: '12345',
                ip: '127.0.0.1'
            })
            .expect(200);
        expect(response.body.success).to.be.true;
        expect(/^[0-9a-f]{24}$/.test(response.body.id)).to.be.true;
        dkim = response.body.id;
    });

    it('should GET /dkim/:dkim expect success', async () => {
        const response = await server.get(`/dkim/${dkim}`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.equal(dkim);
    });

    it('should GET /dkim/resolve/:domain expect success', async () => {
        const response = await server.get(`/dkim/resolve/example.com`).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.id).to.equal(dkim);
    });

    it('should GET /dkim expect success', async () => {
        const response = await server.get(`/dkim`).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.results.length).to.equal(1);
        expect(response.body.results.find(entry => entry.id === dkim)).to.exist;
    });

    it('should DELETE /dkim/:dkim expect success', async () => {
        const response = await server.delete(`/dkim/${dkim}`).expect(200);

        expect(response.body.success).to.be.true;
    });
});
