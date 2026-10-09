'use strict';

const { Readable } = require('stream');

/**
 * Queues a message for forwarding to the configured targets
 *
 * @param {Object} options
 * @param {Maildropper} options.maildrop Queue to push to
 * @param {stream.Readable} [options.stream] Message source
 * @param {Buffer[]} [options.chunks] Message source when no stream is given
 * @returns {Promise<String>} Queue id
 */
module.exports = async options => {
    let mail = {
        parentId: options.parentId,
        reason: 'forward',

        user: options.userData && options.userData._id,
        origin: options.origin,

        from: options.sender,
        to: options.recipient,

        targets: options.targets,

        interface: 'forwarder',

        mtaRelay: options.userData?.mtaRelay || false
    };

    let source = options.stream || Readable.from(options.chunks || [], { objectMode: false });
    let envelope = await options.maildrop.pushStream(mail, source);

    return envelope && envelope.id;
};
