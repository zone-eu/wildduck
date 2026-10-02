/* eslint object-shorthand:0, new-cap: 0, no-useless-concat: 0 */

'use strict';

const { isUtf8 } = require('buffer');

// IMAP Formal Syntax
// http://tools.ietf.org/html/rfc3501#section-9

function expandRange(start, end) {
    let chars = [];
    for (let i = start; i <= end; i++) {
        chars.push(i);
    }
    return String.fromCharCode(...chars);
}

function excludeChars(source, exclude) {
    let sourceArr = Array.prototype.slice.call(source);
    for (let i = sourceArr.length - 1; i >= 0; i--) {
        if (exclude.indexOf(sourceArr[i]) >= 0) {
            sourceArr.splice(i, 1);
        }
    }
    return sourceArr.join('');
}

// filled on first use from ATOM-CHAR, which is built from the grammar
let atomChars = false;

module.exports = {
    CHAR() {
        let value = expandRange(0x01, 0x7f);
        this.CHAR = function () {
            return value;
        };
        return value;
    },

    CHAR8() {
        let value = expandRange(0x01, 0xff);
        this.CHAR8 = function () {
            return value;
        };
        return value;
    },

    SP() {
        return ' ';
    },

    CTL() {
        let value = expandRange(0x00, 0x1f) + '\x7F';
        this.CTL = function () {
            return value;
        };
        return value;
    },

    DQUOTE() {
        return '"';
    },

    ALPHA() {
        let value = expandRange(0x41, 0x5a) + expandRange(0x61, 0x7a);
        this.ALPHA = function () {
            return value;
        };
        return value;
    },

    DIGIT() {
        let value = expandRange(0x30, 0x39);
        this.DIGIT = function () {
            return value;
        };
        return value;
    },

    'ATOM-CHAR'() {
        let value = excludeChars(this.CHAR(), this['atom-specials']());
        this['ATOM-CHAR'] = function () {
            return value;
        };
        return value;
    },

    'ASTRING-CHAR'() {
        let value = this['ATOM-CHAR']() + this['resp-specials']();
        this['ASTRING-CHAR'] = function () {
            return value;
        };
        return value;
    },

    'TEXT-CHAR'() {
        let value = excludeChars(this.CHAR(), '\r\n');
        this['TEXT-CHAR'] = function () {
            return value;
        };
        return value;
    },

    'atom-specials'() {
        let value = '(' + ')' + '{' + this.SP() + this.CTL() + this['list-wildcards']() + this['quoted-specials']() + this['resp-specials']();
        this['atom-specials'] = function () {
            return value;
        };
        return value;
    },

    'list-wildcards'() {
        return '%' + '*';
    },

    'quoted-specials'() {
        let value = this.DQUOTE() + '\\';
        this['quoted-specials'] = function () {
            return value;
        };
        return value;
    },

    'resp-specials'() {
        return ']';
    },

    tag() {
        let value = excludeChars(this['ASTRING-CHAR'](), '+');
        this.tag = function () {
            return value;
        };
        return value;
    },

    command() {
        let value = this.ALPHA() + this.DIGIT() + '-';
        this.command = function () {
            return value;
        };
        return value;
    },

    /**
     * True when a value can not be sent as a quoted string and has to go out as a literal.
     * RFC 3501 4.3: "A quoted string is a sequence of zero or more 7-bit characters, excluding CR
     * and LF", and 9 defines QUOTED-CHAR over TEXT-CHAR, which is any CHAR except CR and LF.
     */
    needsLiteral(value) {
        return /[\r\n]/.test(value);
    },

    /**
     * Quotes a value for the IMAP wire format.
     *
     * RFC 3501 9: QUOTED-CHAR = <any TEXT-CHAR except quoted-specials> / "\" quoted-specials, and
     * quoted-specials = DQUOTE / "\". Only those two may be escaped, unlike a JSON string which
     * also escapes TAB and every control character. The NUL character "MUST NOT be used at any
     * time", so it is dropped.
     */
    quote(value) {
        return (
            '"' +
            value
                .toString()
                // eslint-disable-next-line no-control-regex
                .replace(/\u0000/g, '')
                .replace(/(["\\])/g, '\\$1') +
            '"'
        );
    },

    /**
     * Checks that a binary string with high bit octets is well formed UTF-8.
     *
     * RFC 6855 3: when a client uses the extended quoting mechanism, the server "MUST reject, with
     * a BAD response, any octet sequences with the high bit set that fail to comply with the formal
     * syntax requirements of UTF-8".
     */
    isValidUtf8(value) {
        if (!/[\u0080-\u00ff]/.test(value)) {
            // nothing above 7 bit, no UTF-8 requirement to meet
            return true;
        }

        return isUtf8(Buffer.from(value, 'binary'));
    },

    /**
     * Checks whether a value is an atom.
     *
     * RFC 3501 9: atom = 1*ATOM-CHAR, and ATOM-CHAR is 7 bit. Commands are read as binary strings,
     * so the parser accepts 8-bit bytes in atoms, and the high bit alone is not a reason to answer
     * with a quoted string: a quoted string is a different production, and in an atom-only
     * position such as flag-keyword it is not valid at all. A value above U+00FF never came off
     * the wire, so it is held to the 7-bit rule.
     */
    isAtom(value) {
        value = (value || '').toString();
        if (!value.length) {
            return false;
        }

        if (!atomChars) {
            atomChars = new Set(this['ATOM-CHAR']());
        }

        for (let i = 0, len = value.length; i < len; i++) {
            let code = value.charCodeAt(i);
            if (code >= 0x80 && code <= 0xff) {
                continue;
            }
            if (!atomChars.has(value.charAt(i))) {
                return false;
            }
        }

        return true;
    },

    /**
     * Checks whether a value has to be quoted to take the place of an atom.
     *
     * An empty value carries only a section, as in [PERMANENTFLAGS (...)], and emits nothing.
     * RFC 3501 9: flag = "\" atom / flag-keyword, so a system flag is a backslash plus an atom.
     */
    needsQuoting(value) {
        value = (value || '').toString();
        if (value.charAt(0) === '\\') {
            value = value.slice(1);
        }

        return !!value.length && !this.isAtom(value);
    },

    verify(str, allowedChars) {
        for (let i = 0, len = str.length; i < len; i++) {
            if (allowedChars.indexOf(str.charAt(i)) < 0) {
                return i;
            }
        }
        return -1;
    }
};
