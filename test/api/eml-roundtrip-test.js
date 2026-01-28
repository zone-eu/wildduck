/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */

/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const fs = require('fs');
const path = require('path');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

const fixtureDir = path.join(__dirname, '..', 'fixtures', 'eml');
const baseFixtureNames = ['simple-1.eml', 'simple-2.eml', 'with-attachment.eml'];
const extraFixtureNames = fs
    .readdirSync(fixtureDir)
    .filter(name => /^test_.*\.eml$/.test(name))
    .sort();
const fixtureNames = baseFixtureNames.concat(extraFixtureNames.filter(name => !baseFixtureNames.includes(name)));

const normalizeToCrlf = buffer => Buffer.from(buffer.toString('binary').replace(/\r?\n/g, '\r\n'), 'binary');

const binaryParser = (res, callback) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'binary')));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('EML API roundtrip tests', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;
    let inbox;

    before(async () => {
        const username = `emlroundtrip-${Date.now()}`;
        const response = await server
            .post('/users')
            .send({
                username,
                password: 'secretvalue',
                address: `${username}@example.com`,
                name: 'eml roundtrip user'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        user = response.body.id;

        const mailboxesResponse = await server.get(`/users/${user}/mailboxes`).expect(200);
        inbox = mailboxesResponse.body.results[0].id;
    });

    after(async () => {
        if (!user) {
            return;
        }

        const response = await server.delete(`/users/${user}`).expect(200);
        expect(response.body.success).to.be.true;
        user = false;
    });

    it('should upload and download identical EML files', async () => {
        for (const name of fixtureNames) {
            const rawOnDisk = fs.readFileSync(path.join(fixtureDir, name));
            const raw = normalizeToCrlf(rawOnDisk);

            const upload = await server.post(`/users/${user}/mailboxes/${inbox}/messages`).set('Content-Type', 'message/rfc822').send(raw).expect(200);

            expect(upload.body.success).to.be.true;
            expect(upload.body.message).to.exist;

            const messageId = upload.body.message.id;
            const download = await server
                .get(`/users/${user}/mailboxes/${inbox}/messages/${messageId}/message.eml`)
                .buffer(true)
                .parse(binaryParser)
                .expect(200);

            expect(Buffer.isBuffer(download.body)).to.be.true;
            expect(download.body.equals(raw)).to.be.true;
        }
    });
});
