/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

/* globals before: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const config = require('@zone-eu/wild-config');
const { ObjectId } = require('mongodb');
const { validateChanges } = require('../../lib/webmail/preferences');
const { deleteAccountData } = require('../../lib/jmap/account-data');
const db = require('../../lib/db');
const { connect, uniqueName } = require('./_helpers');

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

async function createUser(prefix) {
    const username = uniqueName(prefix);
    const response = await server
        .post('/users')
        .send({ username, password: 'secretvalue', address: `${username}@example.com` })
        .expect(200);
    return { id: response.body.id, username };
}

describe('Webmail preferences', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let user;

    before(async () => {
        user = await createUser('wmprefs');
    });

    it('returns empty preferences before the first write', async () => {
        const response = await server.get(`/users/${user.id}/webmail/preferences`).expect(200);
        expect(response.body.success).to.be.true;
        expect(response.body.preferences).to.deep.equal({});
        expect(response.body.version).to.equal(1);
        expect(response.body.updated).to.be.null;
    });

    it('merges keys and keeps earlier ones', async () => {
        await server
            .put(`/users/${user.id}/webmail/preferences`)
            .send({ preferences: { theme: 'dark', density: 'compact' } })
            .expect(200);
        const response = await server
            .put(`/users/${user.id}/webmail/preferences`)
            .send({ preferences: { language: 'et', undoSendSeconds: 10 } })
            .expect(200);
        expect(response.body.preferences).to.deep.equal({ theme: 'dark', density: 'compact', language: 'et', undoSendSeconds: 10 });
        expect(response.body.updated).to.be.a('string');
    });

    it('removes a key set to null', async () => {
        const response = await server
            .put(`/users/${user.id}/webmail/preferences`)
            .send({ preferences: { density: null } })
            .expect(200);
        expect(response.body.preferences).to.not.have.property('density');
        expect(response.body.preferences.theme).to.equal('dark');
    });

    it('refuses unknown keys and wrong types without changing anything', async () => {
        for (const preferences of [
            { evil: 1 },
            { theme: 'neon' },
            { threading: 'yes' },
            { undoSendSeconds: 301 },
            { smimeKeyRetention: 'yes' },
            { fontFamily: '<script>' },
            []
        ]) {
            const response = await server.put(`/users/${user.id}/webmail/preferences`).send({ preferences }).expect(400);
            expect(response.body.code).to.equal('InputValidationError');
        }
        const response = await server.get(`/users/${user.id}/webmail/preferences`).expect(200);
        expect(response.body.preferences).to.deep.equal({ theme: 'dark', language: 'et', undoSendSeconds: 10 });
    });

    it('requires the preferences object', async () => {
        await server.put(`/users/${user.id}/webmail/preferences`).send({}).expect(400);
    });

    it('resets every preference', async () => {
        let response = await server.delete(`/users/${user.id}/webmail/preferences`).expect(200);
        expect(response.body.deleted).to.be.true;
        response = await server.get(`/users/${user.id}/webmail/preferences`).expect(200);
        expect(response.body.preferences).to.deep.equal({});
        response = await server.delete(`/users/${user.id}/webmail/preferences`).expect(200);
        expect(response.body.deleted).to.be.false;
    });

    it('keeps users apart and is removed with the user data', async () => {
        const other = await createUser('wmprefsother');
        await server
            .put(`/users/${other.id}/webmail/preferences`)
            .send({ preferences: { accent: 'red' } })
            .expect(200);
        await server
            .put(`/users/${user.id}/webmail/preferences`)
            .send({ preferences: { accent: 'purple' } })
            .expect(200);

        await connect();
        const result = await deleteAccountData(db, new ObjectId(other.id));
        expect(result['webmail.preferences'].deleted).to.equal(1);

        const response = await server.get(`/users/${user.id}/webmail/preferences`).expect(200);
        expect(response.body.preferences).to.deep.equal({ accent: 'purple' });
    });
});

describe('Webmail preference validation', function () {
    it('deduplicates list values', () => {
        expect(validateChanges({ collapsedFolders: ['a', 'b', 'a'] }).set.collapsedFolders).to.deep.equal(['a', 'b']);
    });

    it('splits removals from changes', () => {
        expect(validateChanges({ theme: 'light', accent: null })).to.deep.equal({ set: { theme: 'light' }, unset: ['accent'] });
    });

    it('refuses list items that are not strings', () => {
        expect(() => validateChanges({ collapsedFolders: [1] })).to.throw(/strings/);
    });
});
