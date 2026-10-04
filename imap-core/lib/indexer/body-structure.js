'use strict';

const createEnvelope = require('./create-envelope');
const { decodeWordsSafe } = createEnvelope;
const parseMimeTree = require('./parse-mime-tree');

// RFC 3501 9: body-type-mpart = 1*body SP media-subtype. A multipart whose boundary never appeared has
// no parts, so this empty text part stands in for them
const PLACEHOLDER_PART = parseMimeTree(Buffer.from('Content-Type: text/plain; charset=us-ascii\r\n\r\n'));

/**
 * The parts of a node as IMAP numbers them: the parts of a multipart (the placeholder when it has none),
 * undefined for anything else
 *
 * @param {Object} node A tree node
 * @returns {Array|undefined} Part nodes
 */
function partsOf(node) {
    if (node.childNodes) {
        return node.childNodes;
    }
    return node.boundary ? [PLACEHOLDER_PART] : undefined;
}

class BodyStructure {
    /**
     * Generates an object out of parsed mime tree, that can be serialized into a BODYSTRUCTURE string
     *
     * @param {Object} tree Parsed mime tree (see parse-mime-tree.js for input)
     * @param {Object} [options] Optional options object
     * @param {Boolean} [options.upperCaseKeys] If true, use only upper case key names
     * @param {Boolean} [options.body] If true, skip extension fields (needed for BODY)
     */
    constructor(tree, options) {
        this.tree = tree;
        this.options = options || {};
        this.bodyStructure = this.createBodystructure(this.tree);
    }

    create() {
        return this.bodyStructure;
    }

    createBodystructure(node) {
        let contentType = node.parsedHeader['content-type'] || {};
        switch (contentType.type) {
            case 'multipart':
                // a multipart without a boundary parameter has no parts and is described with the
                // basic fields (RFC 3501 body-type-mpart needs at least one body)
                return partsOf(node) ? this.processMultipartNode(node) : this.processLeaf(node, []);
            case 'text':
                return this.processLeaf(node, [node.lineCount]);
            case 'message':
                // RFC 2045 5.1: the subtype is not case sensitive
                if ((contentType.subtype || '').toLowerCase() === 'rfc822' && node.message) {
                    // the envelope, body structure and line count of the embedded message
                    return this.processLeaf(node, [createEnvelope(node.message.parsedHeader), this.createBodystructure(node.message), node.lineCount]);
                }
            // fall through
            default:
                return this.processLeaf(node, []);
        }
    }

    key(name) {
        return this.options.upperCaseKeys ? name.toUpperCase() : name;
    }

    /**
     * Parameter list of a parsed structured header value, as the flat `(key value key value)` list the
     * response wants, with encoded words in the values decoded
     */
    paramList(parsed) {
        if (!parsed || !parsed.hasParams) {
            return null;
        }
        return Object.keys(parsed.params).flatMap(key => [this.key(key), Buffer.from(decodeWordsSafe(parsed.params[key]).trim())]);
    }

    /**
     * Generates a list of basic fields any non-multipart part should have
     *
     * @param {Object} node A tree node of the parsed mime tree
     * @return {Array} A list of basic fields
     */
    getBasicFields(node) {
        let contentType = node.parsedHeader['content-type'] || {};
        let bodyType = contentType.type || null;
        let bodySubtype = contentType.subtype || null;
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
            this.key(bodyType),
            this.key(bodySubtype),
            // body parameter parenthesized list
            this.paramList(contentType),
            // body id
            node.parsedHeader['content-id'] || null,
            // body description
            node.parsedHeader['content-description'] || null,
            // body encoding
            this.key(contentTransfer),
            // body size
            node.size
        ];
    }

    /**
     * Generates the extension fields every part has (a non-multipart part also has an MD5 before them)
     *
     * @param {Object} node A tree node of the parsed mime tree
     * @return {Array} A list of extension fields
     */
    getExtensionFields(node) {
        let languageString = node.parsedHeader['content-language'] && node.parsedHeader['content-language'].replace(/[ ,]+/g, ',').replace(/^,+|,+$/g, '');
        let language = (languageString && languageString.split(',')) || null;
        let disposition = node.parsedHeader['content-disposition'];

        return [
            // body disposition
            (disposition && [this.key(disposition.value), this.paramList(disposition)]) || null,

            // body language
            language,

            // body location
            //
            // NB! RFC3501 has an errata with content-location type, it is described as
            // 'A string list' (eg. an array) in RFC but the errata page states
            // that it is a string (http://www.rfc-editor.org/errata_search.php?rfc=3501)
            // see note for 'Section 7.4.2, page 75'
            node.parsedHeader['content-location'] || null
        ];
    }

    /**
     * Processes a node with content-type=multipart/*
     *
     * @param {Object} node A tree node of the parsed mime tree
     * @return {Array} BODYSTRUCTURE for a multipart part
     */
    processMultipartNode(node) {
        let data = [...partsOf(node).map(child => this.createBodystructure(child)), this.key(node.multipart)];

        if (this.options.body) {
            // RFC 3501 7.4.2: BODY is BODYSTRUCTURE without extension data, and for a multipart the
            // parameter list is the first extension field (body-ext-mpart)
            return data;
        }

        return [...data, this.paramList(node.parsedHeader['content-type']), ...this.getExtensionFields(node)];
    }

    /**
     * Processes a non-multipart node: the basic fields, the fields of its type (line count for text,
     * envelope and structure for message/rfc822), and the extension fields unless BODY was asked for
     *
     * @param {Object} node A tree node of the parsed mime tree
     * @param {Array} extra Fields specific to the body type
     * @return {Array} BODYSTRUCTURE for the part
     */
    processLeaf(node, extra) {
        let data = [...this.getBasicFields(node), ...extra];
        if (!this.options.body) {
            data = [...data, node.parsedHeader['content-md5'] || null, ...this.getExtensionFields(node)];
        }
        return data;
    }
}

// Expose to the world
module.exports = BodyStructure;
module.exports.partsOf = partsOf;
