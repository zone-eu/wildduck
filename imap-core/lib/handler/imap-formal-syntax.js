/* eslint object-shorthand:0, new-cap: 0, no-useless-concat: 0 */

'use strict';

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

    verify(str, allowedChars) {
        for (let i = 0, len = str.length; i < len; i++) {
            if (allowedChars.indexOf(str.charAt(i)) < 0) {
                return i;
            }
        }
        return -1;
    }
};
