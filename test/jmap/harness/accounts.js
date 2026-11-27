'use strict';

// Test users created through the REST API. Every user created here is deleted after the run.

const crypto = require('crypto');
const { api } = require('./api');

const PASSWORD = 'Jm4pScenario-Secret';
const created = new Set();

/**
 * Creates a user with its default mailboxes.
 *
 * @param {Object} [options] Extra fields for POST /users (quota, name, ...)
 * @returns {Promise<{id: String, username: String, password: String, address: String}>}
 */
async function createUser(options = {}) {
    const username = `jmap${crypto.randomBytes(6).toString('hex')}`;
    const address = `${username}@example.com`;
    const res = await api('POST', '/users', Object.assign({ username, password: PASSWORD, address, name: `JMAP ${username}` }, options));
    created.add(res.id);
    return { id: res.id, username, password: options.password || PASSWORD, address: options.address || address };
}

async function deleteUser(id) {
    created.delete(id);
    await api('DELETE', `/users/${id}`);
}

/** Mailboxes of a user keyed by path, and by special use for the default ones. */
async function mailboxes(user) {
    const res = await api('GET', `/users/${user.id}/mailboxes`);
    const byPath = {};
    for (const mailbox of res.results) {
        byPath[mailbox.path] = mailbox;
        if (mailbox.specialUse) {
            byPath[mailbox.specialUse] = mailbox;
        }
    }
    return byPath;
}

/** Creates an application specific password and returns it. */
async function createAsp(user, scopes = ['*'], description = 'jmap scenario') {
    const res = await api('POST', `/users/${user.id}/asps`, { description, scopes, generateMobileconfig: false });
    return res.password;
}

/** Issues a user access token with the account password. */
async function createToken(user, scope = 'master') {
    const res = await api('POST', '/authenticate', { username: user.username, password: user.password, scope, token: true });
    return res.token;
}

/** Deletes every user created during the run, a few at a time. Called from the root after hook. */
async function cleanup(concurrency = 10) {
    const ids = [...created];
    created.clear();
    const worker = async () => {
        while (ids.length) {
            await api('DELETE', `/users/${ids.pop()}`).catch(() => false);
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
}

module.exports = { createUser, deleteUser, mailboxes, createAsp, createToken, cleanup, PASSWORD };
