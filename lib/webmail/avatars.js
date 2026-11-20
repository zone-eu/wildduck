'use strict';

// Pictures a webmail client shows for the user (key "self") and later for contact groups
// ("group:<id>"). Small images only; the client sends them already resized.

const { Binary } = require('mongodb');
const { invalid } = require('./preferences');

const MAX_BYTES = 256 * 1024;
const TYPES = new Map([
    ['image/png', [0x89, 0x50, 0x4e, 0x47]],
    ['image/jpeg', [0xff, 0xd8, 0xff]],
    ['image/webp', [0x52, 0x49, 0x46, 0x46]],
    ['image/gif', [0x47, 0x49, 0x46, 0x38]]
]);
const KEY = /^(self|group:[A-Za-z0-9_-]{1,64})$/;

/** The image bytes when they are what the content type says; otherwise an input error */
function checkImage(contentType, content) {
    const magic = TYPES.get(contentType);
    if (!magic) {
        throw invalid('Must be a PNG, JPEG, WebP or GIF image', 'contentType');
    }
    const data = Buffer.from(content || '', 'base64');
    if (!data.length || data.length > MAX_BYTES) {
        throw invalid(`Must be 1 to ${MAX_BYTES} bytes`, 'content', 'TooLarge');
    }
    if (!magic.every((byte, i) => data[i] === byte)) {
        throw invalid('The content is not a valid image of that type', 'content');
    }
    return data;
}

class WebmailAvatars {
    constructor(db) {
        this.collection = db.database.collection('webmail.avatars');
    }

    static checkKey(key) {
        if (!KEY.test(key || '')) {
            throw invalid('Must be "self" or "group:<id>"', 'key');
        }
        return key;
    }

    async get(user, key) {
        const doc = await this.collection.findOne({ user, key: WebmailAvatars.checkKey(key) });
        return doc ? { contentType: doc.contentType, data: Buffer.from(doc.data.buffer), updated: doc.updated } : null;
    }

    async set(user, key, contentType, content) {
        const data = checkImage(contentType, content);
        const updated = new Date();
        await this.collection.updateOne(
            { user, key: WebmailAvatars.checkKey(key) },
            { $set: { user, key, contentType, data: new Binary(data), size: data.length, updated } },
            { upsert: true }
        );
        return { contentType, size: data.length, updated };
    }

    async remove(user, key) {
        const result = await this.collection.deleteOne({ user, key: WebmailAvatars.checkKey(key) });
        return result.deletedCount > 0;
    }
}

module.exports = { WebmailAvatars, MAX_AVATAR_BYTES: MAX_BYTES };
