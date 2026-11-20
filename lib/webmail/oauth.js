'use strict';

// OAuth clients and grants for a webmail's authorisation server (MCP clients). Clients are not per
// user: they register themselves (RFC 7591) through the webmail, which alone reaches them. A
// registered client that never gets a grant is removed after a week. Grants are per user, each
// linked to the MCP token it issued; token values are kept as SHA-256 hashes only, and removing a
// grant revokes its MCP token.

const { ObjectId } = require('mongodb');
const { invalid } = require('./preferences');

const UNUSED_CLIENT_TTL = 7 * 24 * 3600 * 1000;
const MAX_GRANTS = 50;
const MAX_REDIRECT_URIS = 10;
const HASH = /^[a-f0-9]{64}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A redirect URI a client may use: https, or http on the loopback interface; no fragment. */
function checkRedirectUri(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw invalid('Must be an absolute URL', 'redirectUris');
    }
    const loopback = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
    if ((url.protocol !== 'https:' && !loopback) || url.hash || url.username || url.password) {
        throw invalid('Must be an https URL (or http on localhost) without a fragment or credentials', 'redirectUris');
    }
    return value;
}

const clientView = doc => ({
    id: doc._id.toString(),
    name: doc.name,
    redirectUris: doc.redirectUris,
    created: doc.created
});

class WebmailOauthClients {
    constructor(db) {
        this.collection = db.database.collection('webmail.oauthclients');
    }

    async create({ name, redirectUris }) {
        const uris = [...new Set((redirectUris || []).map(checkRedirectUri))];
        if (!uris.length || uris.length > MAX_REDIRECT_URIS) {
            throw invalid(`Give 1 to ${MAX_REDIRECT_URIS} redirect URIs`, 'redirectUris');
        }
        const created = new Date();
        const doc = {
            _id: new ObjectId(),
            name: String(name || '').trim(),
            redirectUris: uris,
            created,
            // removed by the TTL index unless a grant uses it first
            expires: new Date(created.getTime() + UNUSED_CLIENT_TTL)
        };
        if (!doc.name) {
            throw invalid('A name is required', 'name');
        }
        await this.collection.insertOne(doc);
        return clientView(doc);
    }

    async get(id) {
        const doc = await this.collection.findOne({ _id: new ObjectId(id) });
        return doc ? clientView(doc) : null;
    }

    /** A client in use stays (no expiry) */
    async markUsed(id) {
        await this.collection.updateOne({ _id: new ObjectId(id), expires: { $exists: true } }, { $unset: { expires: true } });
    }

    async remove(id) {
        const result = await this.collection.deleteOne({ _id: new ObjectId(id) });
        return result.deletedCount > 0;
    }
}

const grantView = doc => ({
    id: doc._id.toString(),
    client: doc.client.toString(),
    clientName: doc.clientName,
    scope: doc.scope,
    mcpToken: doc.mcpToken.toString(),
    created: doc.created,
    updated: doc.updated,
    expires: doc.expires
});

function checkHash(value, key) {
    if (!HASH.test(value || '')) {
        throw invalid('Must be a SHA-256 hash in hex', key);
    }
    return value;
}

/** The token fields a grant stores: the MCP token it issued and hashes of its tokens */
const tokenFields = data => ({
    mcpToken: new ObjectId(data.mcpToken),
    refreshHash: checkHash(data.refreshHash, 'refreshHash'),
    accessHash: checkHash(data.accessHash, 'accessHash')
});

class WebmailOauthGrants {
    constructor(db, { clients, mcpTokenHandler }) {
        this.collection = db.database.collection('webmail.oauthgrants');
        this.clients = clients;
        this.mcpTokenHandler = mcpTokenHandler;
    }

    /** The user's grants; with a hash, only the grant holding that refresh or access token */
    async list(user, { refreshHash, accessHash } = {}) {
        const query = { user };
        if (refreshHash) {
            query.refreshHash = checkHash(refreshHash, 'refreshHash');
        }
        if (accessHash) {
            query.accessHash = checkHash(accessHash, 'accessHash');
        }
        const docs = await this.collection.find(query).sort({ created: 1 }).limit(MAX_GRANTS).toArray();
        return docs.map(grantView);
    }

    async create(user, data) {
        const [client, count] = await Promise.all([this.clients.get(data.client), this.collection.countDocuments({ user })]);
        if (!client) {
            throw invalid('No such client', 'client', 'ClientNotFound');
        }
        if (count >= MAX_GRANTS) {
            throw invalid(`At most ${MAX_GRANTS} connected clients`, 'client', 'TooManyGrants');
        }
        const now = new Date();
        const doc = {
            _id: new ObjectId(),
            user,
            client: new ObjectId(data.client),
            clientName: client.name,
            scope: data.scope,
            ...tokenFields(data),
            created: now,
            updated: now,
            expires: new Date(data.expires)
        };
        await this.collection.insertOne(doc);
        await this.clients.markUsed(data.client);
        return grantView(doc);
    }

    /**
     * A refresh: the new MCP token and hashes, only while the grant still holds the refresh token
     * being used (a second refresh with the same token finds nothing); the old MCP token is revoked
     */
    async rotate(user, id, data) {
        const update = { ...tokenFields(data), updated: new Date() };
        const previous = await this.collection.findOneAndUpdate(
            { _id: new ObjectId(id), user, refreshHash: checkHash(data.previousRefreshHash, 'previousRefreshHash') },
            { $set: update }
        );
        if (!previous) {
            return null;
        }
        await this.revokeToken(user, previous.mcpToken);
        return grantView({ ...previous, ...update });
    }

    /** Removes the grant and revokes its MCP token */
    async remove(user, id) {
        const doc = await this.collection.findOneAndDelete({ _id: new ObjectId(id), user });
        if (!doc) {
            return false;
        }
        await this.revokeToken(user, doc.mcpToken);
        return true;
    }

    async revokeToken(user, token) {
        try {
            await this.mcpTokenHandler.revoke(user, token, {});
        } catch (err) {
            // already gone (expired, revoked from the token list, retired by a password change)
            if (err.code !== 'McpTokenNotFound') {
                throw err;
            }
        }
    }
}

module.exports = { WebmailOauthClients, WebmailOauthGrants, MAX_GRANTS, MAX_REDIRECT_URIS };
