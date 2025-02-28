'use strict';

const os = require('os');
const { randomUUID: uuid } = require('crypto');
const HTMLParser = require('node-html-parser');

function processDataUrl(element, useBase64) {
    let parts = (element.path || element.href).match(/^data:((?:[^;]*;)*(?:[^,]*)),(.*)$/i);
    if (!parts) {
        return element;
    }

    if (useBase64) {
        element.content = /\bbase64$/i.test(parts[1])
            ? Buffer.from(parts[2], 'base64').toString('base64')
            : Buffer.from(decodeURIComponent(parts[2])).toString('base64');
        element.encoding = 'base64';
    } else {
        element.content = /\bbase64$/i.test(parts[1]) ? Buffer.from(parts[2], 'base64') : Buffer.from(decodeURIComponent(parts[2]));
    }

    if ('path' in element) {
        delete element.path;
    }

    if ('href' in element) {
        delete element.href;
    }

    parts[1].split(';').forEach(item => {
        if (/^\w+\/[^/]+$/i.test(item)) {
            element.contentType = element.contentType || item.toLowerCase();
        }
    });

    return element;
}
function preprocessHtml(html, hostname) {
    if (Buffer.isBuffer(html)) {
        html = html.toString();
    }

    const root = HTMLParser.parse(html);
    let attachments = [];

    for (let img of root.getElementsByTagName('img')) {
        let src = img.getAttribute('src');
        if (/^data:/.test(src)) {
            try {
                let attachment = processDataUrl({ href: src }, true);
                if (attachment) {
                    let filename = img.getAttribute('data-filename');
                    if (filename) {
                        attachment.filename = filename;
                        img.removeAttribute('data-filename');
                    }
                    attachment.cid = `${uuid()}@${hostname ? hostname : 'inline'}`;
                    img.setAttribute('src', `cid:${attachment.cid}`);

                    attachments.push(attachment);
                }
            } catch (err) {
                // should log?
                console.error(err);
            }
        }
    }

    return {
        html: attachments.length ? root.outerHTML : html,
        attachments
    };
}

function preprocessAttachments(data) {
    let hostname = data.from && data.from.address && typeof data.from.address === 'string' ? data.from.address.split('@').pop() : os.hostname();

    if (!data.html || !data.html.length || data.html.length > 12 * 1024 * 1024) {
        return;
    }

    try {
        let { html, attachments } = preprocessHtml(data.html, hostname);

        if (html) {
            data.html = html;
        }

        if (attachments && attachments.length) {
            data.attachments = [].concat(data.attachments || []).concat(attachments);
        }
    } catch (err) {
        // should log?
        console.error(err);
    }
}

module.exports = {
    processDataUrl,
    preprocessAttachments
};
