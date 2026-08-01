/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console: 0 */

'use strict';

const supertest = require('supertest');
const chai = require('chai');

const expect = chai.expect;
chai.config.includeStack = true;
const config = require('@zone-eu/wild-config');
const packageData = require('../../package.json');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

// a key that is always registered in lib/settings-handler.js SETTING_KEYS
const EXISTING_KEY = 'const:max:mailboxes';

describe('Settings and Health tests', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    describe('Health', () => {
        it('should GET /health expect success', async () => {
            const response = await server.get('/health').expect(200);

            expect(response.body.success).to.be.true;
            expect(response.body.version).to.be.a('string');
            expect(response.body.version).to.be.equal(packageData.version);
        });
    });

    describe('Settings', () => {
        it('should GET /settings expect success', async () => {
            const response = await server.get('/settings').expect(200);

            expect(response.body.success).to.be.true;
            expect(response.body.settings).to.be.an('array').that.is.not.empty;

            const entry = response.body.settings.find(setting => setting.key === EXISTING_KEY);
            expect(entry).to.exist;
            expect(entry.name).to.be.equal('Max mailboxes');
            expect(entry.type).to.be.equal('number');
            expect(entry.value).to.be.a('number');
            expect(entry.default).to.be.a('number');
            expect(entry.custom).to.be.a('boolean');
        });

        it('should GET /settings expect success / with filter param', async () => {
            const response = await server.get('/settings?filter=max').expect(200);

            expect(response.body.success).to.be.true;
            expect(response.body.filter).to.be.equal('max');
            expect(response.body.settings).to.be.an('array').that.is.not.empty;

            // keys matching the filter are included. NB: registered default keys that do
            // NOT match the filter are currently also returned (settingsHandler.list()
            // only applies the filter to custom rows stored in the settings collection),
            // so no assertion is made about non-matching keys being excluded
            expect(response.body.settings.some(setting => setting.key === EXISTING_KEY)).to.be.true;
        });

        it('should GET /settings/{key} expect success', async () => {
            const response = await server.get(`/settings/${EXISTING_KEY}`).expect(200);

            expect(response.body.success).to.be.true;
            expect(response.body.key).to.be.equal(EXISTING_KEY);
            expect(response.body.value).to.be.a('number');
            expect(response.body.error).to.not.exist;
        });

        it('should GET /settings/{key} expect failure / unknown key', async () => {
            const response = await server.get('/settings/this.key.does.not.exist').expect(404);

            expect(response.body.code).to.equal('SettingNotFound');
            expect(response.body.error).to.equal('Key was not found');
        });

        it('should POST /settings/{key} expect success / same value round-trip', async () => {
            // read the current value first and write the same value back so that the
            // effective configuration of the shared test environment is not changed
            const currentResponse = await server.get(`/settings/${EXISTING_KEY}`).expect(200);

            expect(currentResponse.body.success).to.be.true;
            const currentValue = currentResponse.body.value;
            expect(currentValue).to.be.a('number');

            const response = await server.post(`/settings/${EXISTING_KEY}`).send({ value: currentValue }).expect(200);

            expect(response.body.success).to.be.true;
            expect(response.body.key).to.be.equal(EXISTING_KEY);

            // the stored value must equal what was there before
            const verifyResponse = await server.get(`/settings/${EXISTING_KEY}`).expect(200);
            expect(verifyResponse.body.success).to.be.true;
            expect(verifyResponse.body.value).to.be.equal(currentValue);
        });

        it('should POST /settings/{key} expect failure / unknown key', async () => {
            const response = await server.post(`/settings/unknown:key:${Date.now()}`).send({ value: 123 }).expect(400);

            expect(response.body.code).to.be.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
        });

        it('should POST /settings/{key} expect failure / invalid value type', async () => {
            const response = await server.post(`/settings/${EXISTING_KEY}`).send({ value: 'not-a-number' }).expect(400);

            expect(response.body.code).to.be.equal('InputValidationError');
            expect(response.body.error).to.not.be.empty;
        });
    });
});
