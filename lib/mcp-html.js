'use strict';

// Turns a stored HTML message body into something safe to hand to an agent.
//
// This is not a defence against prompt injection, which no sanitizer can fix: the words in a
// message are attacker-controlled whatever the markup around them looks like. It exists so
// that an MCP result is inert data rather than an active payload, because an MCP client is far
// likelier to render a tool result than an API consumer is to render a REST response.
//
// Built on sanitize-html rather than a general HTML parser. A parser that is not written for
// this job leaves gaps that are not configurable away: raw-text elements whose contents are
// never tokenised, and tag forms such as `<img/src=x onerror=...>` that a lenient regex does
// not match but a browser parses as an ordinary tag with attributes. Both emit attacker markup
// verbatim. An allowlist over a spec-compliant tokeniser has neither failure mode.
//
// The policy is an allowlist twice over: only these tags survive, only these attributes on
// them, and only these URL schemes in those attributes. Anything unrecognised is dropped
// rather than inspected, so a construct nobody thought of fails closed.

const sanitizeHtml = require('sanitize-html');

// Structural and text markup an agent might reasonably want to read. No media elements, no
// form controls, no svg or math: every one of those either loads something remote, collects
// input, or opens a foreign parsing context, and none of them carries readable content.
const ALLOWED_TAGS = [
    'p', 'br', 'hr', 'div', 'span', 'blockquote', 'pre', 'code', 'kbd', 'samp',
    'em', 'strong', 'b', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark', 'sub', 'sup', 'small',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'a', 'img', 'figure', 'figcaption', 'address', 'cite', 'q', 'abbr', 'time'
];

// `cid:` names an attachment of this same message, which is the one reference worth keeping:
// it tells an agent which attachment an inline image refers to. A remote reference is how a
// sender learns a message was opened, so images may carry nothing else.
const SAFE_SCHEMES = ['http', 'https', 'mailto', 'cid'];
const CID_ONLY = /^cid:/i;

const POLICY = {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
        a: ['href', 'title'],
        img: ['src', 'alt', 'title', 'width', 'height'],
        td: ['colspan', 'rowspan'],
        th: ['colspan', 'rowspan', 'scope'],
        col: ['span'],
        colgroup: ['span'],
        time: ['datetime'],
        abbr: ['title'],
        blockquote: ['cite'],
        q: ['cite'],
        '*': ['dir', 'lang']
    },
    allowedSchemes: SAFE_SCHEMES,
    // A protocol-relative reference resolves against the consumer's own page, so it is a
    // remote load wearing a relative disguise
    allowProtocolRelative: false,
    // Anything not on the tag list loses its markup but keeps its text, except where the text
    // is code rather than content
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'template', 'title'],
    disallowedTagsMode: 'discard',
    transformTags: {
        img: (tagName, attribs) => {
            // Relative and same-origin references are remote loads too once the consumer
            // resolves them against its own base, so an image keeps a source only when it
            // names an attachment of this message.
            let src = (attribs.src || '').toString();
            let cleaned = Object.assign({}, attribs);
            if (!CID_ONLY.test(src.trim())) {
                delete cleaned.src;
            }
            return { tagName, attribs: cleaned };
        }
    }
};

/**
 * Strips scripting, remote references and styling from an HTML message body.
 *
 * @param {*} html Stored HTML, as a string or an array of parts.
 * @returns {String} Inert HTML.
 */
function webSafeHtml(html) {
    let source = []
        .concat(html || [])
        .filter(part => typeof part === 'string')
        .join('\n');

    if (!source.trim()) {
        return '';
    }

    try {
        return sanitizeHtml(source, POLICY);
    } catch (err) {
        // An unusable body is not worth failing a read over, and returning the raw source
        // would defeat the point of this function
        return '';
    }
}

module.exports = { webSafeHtml, ALLOWED_TAGS, SAFE_SCHEMES };
