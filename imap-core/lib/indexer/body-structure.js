'use strict';

const libmime = require('libmime');
const createEnvelope = require('./create-envelope');

class BodyStructure {
    constructor(tree, options) {
        this.tree = tree;
        this.options = options || {};
        this.currentPath = '';
        this.bodyStructure = this.createBodystructure(this.tree, this.options);
    }

    create() {
        return this.bodyStructure;
    }

    /**
     * Generates an object out of parsed mime tree, that can be
     * serialized into a BODYSTRUCTURE string
     *
     * @param {Object} tree Parsed mime tree (see mimeparser.js for input)
     * @param {Object} [options] Optional options object
     * @param {Boolean} [options.contentLanguageString] If true, convert single element array to string for Content-Language
     * @param {Boolean} [options.upperCaseKeys] If true, use only upper case key names
     * @param {Boolean} [options.skipContentLocation] If true, do not include Content-Location in the output
     * @param {Boolean} [options.body] If true, skip extension fields (needed for BODY)
     * @param {Object} Object structure in the form of BODYSTRUCTURE
     */
    createBodystructure(tree, options) {
        options = options || {};

        let walker = node => {
            let contentType = node.parsedHeader['content-type'] || {};
            switch (contentType.type) {
                case 'multipart':
                    if (node.multipart) {
                        return this.processMultipartNode(node, options);
                    }
                    // RFC 3501 body-type-mpart needs at least one body: a multipart without a
                    // boundary parameter has no parts and is described with the basic fields
                    return this.processAttachmentNode(node, options);
                case 'text':
                    return this.processTextNode(node, options);
                case 'message':
                    // RFC 2045 5.1: the subtype is not case sensitive
                    if ((contentType.subtype || '').toLowerCase() === 'rfc822' && node.message && !options.attachmentRFC822) {
                        return this.processRFC822Node(node, options);
                    }
                // fall through
                default:
                    return this.processAttachmentNode(node, options);
            }
        };
        return walker(tree);
    }

    /**
     * Generates a list of basic fields any non-multipart part should have
     *
     * @param {Object} node A tree node of the parsed mime tree
     * @param {Object} [options] Optional options object (see createBodystructure for details)
     * @return {Array} A list of basic fields
     */
    getBasicFields(node, options) {
        let bodyType = (node.parsedHeader['content-type'] && node.parsedHeader['content-type'].type) || null;
        let bodySubtype = (node.parsedHeader['content-type'] && node.parsedHeader['content-type'].subtype) || null;
        let contentTransfer = node.parsedHeader['content-transfer-encoding'] || '7bit';

        if (!bodyType || !bodySubtype) {
            // prevent strange content types like (NIL "/ms-word") that may break some clients
            if (bodyType === 'text' || bodySubtype === 'plain') {
                bodyType = 'text';
                bodySubtype = 'plain';
            } else {
                bodyType = 'application';
                bodySubtype = 'octet-stream';
            }
        }

        return [
            // body type
            options.upperCaseKeys ? (bodyType && bodyType.toUpperCase()) || null : bodyType,

            // body subtype
            options.upperCaseKeys ? (bodySubtype && bodySubtype.toUpperCase()) || null : bodySubtype,

            // body parameter parenthesized list
            (node.parsedHeader['content-type'] &&
                node.parsedHeader['content-type'].hasParams &&
                this.flatten(
                    Object.keys(node.parsedHeader['content-type'].params).map(key => {
                        let value = node.parsedHeader['content-type'].params[key];
                        try {
                            value = Buffer.from(libmime.decodeWords(value).trim());
                        } catch (E) {
                            // failed to parse value
                        }
                        return [options.upperCaseKeys ? key.toUpperCase() : key, value];
                    })
                )) ||
                null,

            // body id
            node.parsedHeader['content-id'] || null,

            // body description
            node.parsedHeader['content-description'] || null,

            // body encoding
            options.upperCaseKeys ? (contentTransfer && contentTransfer.toUpperCase()) || '7bit' : contentTransfer,

            // body size
            node.size
        ];
    }

    /**
     * Generates a list of extension fields any non-multipart part should have
     *
     * @param {Object} node A tree node of the parsed mime tree
     * @param {Object} [options] Optional options object (see createBodystructure for details)
     * @return {Array} A list of extension fields
     */
    getExtensionFields(node, options) {
        options = options || {};

        let languageString = node.parsedHeader['content-language'] && node.parsedHeader['content-language'].replace(/[ ,]+/g, ',').replace(/^,+|,+$/g, '');
        let language = (languageString && languageString.split(',')) || null;
        let data;

        // if `contentLanguageString` is true, then use a string instead of single element array
        if (language && language.length === 1 && options.contentLanguageString) {
            language = language[0];
        }

        data = [
            // body MD5
            node.parsedHeader['content-md5'] || null,

            // body disposition
            (node.parsedHeader['content-disposition'] && [
                options.upperCaseKeys ? node.parsedHeader['content-disposition'].value.toUpperCase() : node.parsedHeader['content-disposition'].value,
                (node.parsedHeader['content-disposition'].params &&
                    node.parsedHeader['content-disposition'].hasParams &&
                    this.flatten(
                        Object.keys(node.parsedHeader['content-disposition'].params).map(key => {
                            let value = node.parsedHeader['content-disposition'].params[key];
                            try {
                                value = Buffer.from(libmime.decodeWords(value).trim());
                            } catch (E) {
                                // failed to parse value
                            }
                            return [options.upperCaseKeys ? key.toUpperCase() : key, value];
                        })
                    )) ||
                    null
            ]) ||
                null,

            // body language
            language
        ];

        // if `skipContentLocation` is true, do not include Content-Location in output
        //
        // NB! RFC3501 has an errata with content-location type, it is described as
        // 'A string list' (eg. an array) in RFC but the errata page states
        // that it is a string (http://www.rfc-editor.org/errata_search.php?rfc=3501)
        // see note for 'Section 7.4.2, page 75'
        if (!options.skipContentLocation) {
            // body location
            data.push(node.parsedHeader['content-location'] || null);
        }

        return data;
    }

    /**
     * Processes a node with content-type=multipart/*
     *
     * @param {Object} node A tree node of the parsed mime tree
     * @param {Object} [options] Optional options object (see createBodystructure for details)
     * @return {Array} BODYSTRUCTURE for a multipart part
     */
    processMultipartNode(node, options) {
        options = options || {};

        let parts = (node.childNodes && node.childNodes.map(tree => this.createBodystructure(tree, options))) || [];
        if (!parts.length) {
            // RFC 3501 9: body-type-mpart = 1*body SP media-subtype. A multipart whose boundary never
            // appeared has no parts, so an empty text part stands in for them
            parts = [this.createBodystructure({ parsedHeader: { 'content-type': { type: 'text', subtype: 'plain', params: { charset: 'us-ascii' }, hasParams: true } }, size: 0, lineCount: 0 }, options)];
        }

        let data = parts.concat([
            // body subtype
            options.upperCaseKeys ? (node.multipart && node.multipart.toUpperCase()) || null : node.multipart
        ]);

        if (options.body) {
            // RFC 3501 7.4.2: BODY is BODYSTRUCTURE without extension data, and for a multipart the
            // parameter list is the first extension field (body-ext-mpart)
            return data;
        }

        data = data.concat([
            // body parameter parenthesized list
            (node.parsedHeader['content-type'] &&
                node.parsedHeader['content-type'].hasParams &&
                this.flatten(
                    Object.keys(node.parsedHeader['content-type'].params).map(key => {
                        let value = node.parsedHeader['content-type'].params[key];
                        try {
                            value = Buffer.from(libmime.decodeWords(value).trim());
                        } catch (E) {
                            // failed to parse value
                        }
                        return [options.upperCaseKeys ? key.toUpperCase() : key, value];
                    })
                )) ||
                null
        ]);

        // skip body MD5 from extension fields
        return data.concat(this.getExtensionFields(node, options).slice(1));
    }

    /**
     * Processes a node with content-type=text/*
     *
     * @param {Object} node A tree node of the parsed mime tree
     * @param {Object} [options] Optional options object (see createBodystructure for details)
     * @return {Array} BODYSTRUCTURE for a text part
     */
    processTextNode(node, options) {
        options = options || {};

        let data = [].concat(this.getBasicFields(node, options)).concat([node.lineCount]);

        if (!options.body) {
            data = data.concat(this.getExtensionFields(node, options));
        }

        return data;
    }

    /**
     * Processes a non-text, non-multipart node
     *
     * @param {Object} node A tree node of the parsed mime tree
     * @param {Object} [options] Optional options object (see createBodystructure for details)
     * @return {Array} BODYSTRUCTURE for the part
     */
    processAttachmentNode(node, options) {
        options = options || {};

        let data = [].concat(this.getBasicFields(node, options));

        if (!options.body) {
            data = data.concat(this.getExtensionFields(node, options));
        }

        return data;
    }

    /**
     * Processes a node with content-type=message/rfc822
     *
     * @param {Object} node A tree node of the parsed mime tree
     * @param {Object} [options] Optional options object (see createBodystructure for details)
     * @return {Array} BODYSTRUCTURE for a text part
     */
    processRFC822Node(node, options) {
        options = options || {};

        let data = [].concat(this.getBasicFields(node, options));

        data.push(createEnvelope(node.message.parsedHeader));
        data.push(this.createBodystructure(node.message, options));
        data = data.concat(node.lineCount).concat(this.getExtensionFields(node, options));

        return data;
    }

    /**
     * Converts all sub-arrays into one level array
     * flatten([1,[2,3]]) -> [1,2,3]
     *
     * @param {Array} arr An array with possible sub-arrays
     * @return {Array} Flat array
     */
    flatten(arr) {
        let result = [];
        if (Array.isArray(arr)) {
            arr.forEach(elm => {
                if (Array.isArray(elm)) {
                    result = result.concat(this.flatten(elm));
                } else {
                    result.push(elm);
                }
            });
        } else {
            result.push(arr);
        }
        return result;
    }
}

// Expose to the world
module.exports = BodyStructure;
