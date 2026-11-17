'use strict';

// Test messages: built in code with nodemailer's MailComposer, or read from WildDuck's own
// fixture directories. Messages from other projects' test suites are never copied here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MailComposer = require('nodemailer/lib/mail-composer');

const REPO = path.join(__dirname, '..', '..', '..');
const FIXTURE_DIRS = [path.join(REPO, 'imap-core', 'test', 'fixtures'), path.join(REPO, 'test', 'fixtures'), path.join(__dirname, '..', 'fixtures')];

/**
 * Builds an RFC 822 message. Defaults give a plain text message with a unique subject and
 * Message-ID, so tests can find their own messages.
 *
 * @param {Object} [options] MailComposer options (from, to, subject, text, html, attachments, headers, date, messageId, ...)
 * @returns {Promise<Buffer>}
 */
function buildMessage(options = {}) {
    const tag = crypto.randomBytes(4).toString('hex');
    const mail = new MailComposer(
        Object.assign(
            {
                from: 'Sender <sender@example.net>',
                to: 'Recipient <recipient@example.com>',
                subject: `Scenario message ${tag}`,
                text: `Body of scenario message ${tag}`,
                messageId: `<${tag}.${Date.now()}@scenario.example>`,
                date: new Date()
            },
            options
        )
    );
    return new Promise((resolve, reject) => mail.compile().build((err, raw) => (err ? reject(err) : resolve(raw))));
}

/** Reads a fixture file by name from the known fixture directories. */
function readFixture(name) {
    for (const dir of FIXTURE_DIRS) {
        const file = path.join(dir, name);
        if (fs.existsSync(file)) {
            return fs.readFileSync(file);
        }
    }
    throw new Error(`fixture ${name} not found`);
}

/** Lists fixture files with the given extension (default .eml) in one directory or all of them. */
function listFixtures(extension = '.eml', dirs = FIXTURE_DIRS) {
    const files = [];
    for (const dir of dirs) {
        if (fs.existsSync(dir)) {
            for (const name of fs.readdirSync(dir).sort()) {
                if (name.endsWith(extension)) {
                    files.push(path.join(dir, name));
                }
            }
        }
    }
    return files;
}

module.exports = { buildMessage, readFixture, listFixtures, FIXTURE_DIRS };
