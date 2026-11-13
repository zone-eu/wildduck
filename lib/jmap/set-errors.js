'use strict';

// SetError (RFC 8620 5.3): the per object error of a /set, /copy or /import call. Thrown by the
// validation helpers and turned into a notCreated, notUpdated or notDestroyed entry by the caller.

class SetError extends Error {
    /**
     * @param {String} type SetError type, for example invalidProperties or blobNotFound
     * @param {String} [description]
     * @param {Object} [extra] properties added to the SetError, for example {properties: [...]} or {notFound: [...]}
     */
    constructor(type, description, extra) {
        super(description || type);
        this.type = type;
        this.description = description;
        this.extra = extra || {};
    }

    toSetError() {
        return Object.assign({ type: this.type }, this.description ? { description: this.description } : {}, this.extra);
    }
}

/** invalidProperties naming the offending properties */
const invalidProperties = (properties, description) => new SetError('invalidProperties', description, { properties: [].concat(properties) });

module.exports = { SetError, invalidProperties };
