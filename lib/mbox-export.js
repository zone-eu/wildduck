'use strict';

const log = require('npmlog');
const Newlines = require('./newlines');
const MboxStream = require('./mbox-stream');
const HeaderSplitter = require('./header-splitter');
const PassThrough = require('stream').PassThrough;

async function mboxExport(auditHandler, audit) {
    let outputStream = new PassThrough();

    let processExport = async () => {
        let cursor = await auditHandler.gridfs
            .collection('audit.files')
            .find({ 'metadata.audit': audit }, { noCursorTimeout: true })
            .project({ _id: true, metadata: true })
            .sort({ 'metadata.date': 1 });

        let messageData;
        let counter = 0;
        while ((messageData = await cursor.next())) {
            try {
                let sourceStream = await auditHandler.retrieve(messageData._id);
                if (!sourceStream) {
                    log.error('Audit', `Missing source for ${messageData._id} from ${audit}`);
                    continue;
                }
                await writeEmailToMboxStream(sourceStream, outputStream, {
                    from: messageData.metadata && messageData.metadata.info && messageData.metadata.info.from,
                    date: messageData.metadata && ((messageData.metadata.info && messageData.metadata.info.time) || messageData.metadata.date),
                    draft: !!(messageData.metadata && messageData.metadata.draft),
                    mailboxPath: messageData.metadata && messageData.metadata.mailboxPath
                });
                counter++;
            } catch (err) {
                // ignore?
                log.error('Audit', `Failed exporting ${messageData._id} from ${audit}: ${err.message}`);
            }
        }
        log.info('Audit', `Exported ${counter} messages from ${audit}`);
        await cursor.close();
    };

    setImmediate(() => {
        processExport()
            .then(() => {
                try {
                    outputStream.end();
                } catch (err) {
                    // ignore at this point
                }
            })
            .catch(err => {
                try {
                    outputStream.end('\n' + err.message);
                } catch (err) {
                    //ignore
                }
            });
    });

    return outputStream;
}

async function writeEmailToMboxStream(sourceStream, outputStream, mboxOptions) {
    await new Promise((resolve, reject) => {
        let headerSplitter = new HeaderSplitter();

        mboxOptions = mboxOptions || {};

        let newlines = new Newlines();
        let mboxStream = new MboxStream(mboxOptions);

        sourceStream.once('error', err => {
            sourceStream.unpipe(headerSplitter);
            mboxStream.unpipe(outputStream);
            reject(err);
        });

        mboxStream.once('end', () => resolve());

        headerSplitter.on('headers', data => {
            data.headers.remove('X-Export-Draft');
            if (mboxOptions.draft) {
                data.headers.add('X-Export-Draft', 'Yes', 0);
            }

            data.headers.remove('X-Export-Mailbox');
            if (mboxOptions.mailboxPath) {
                data.headers.add('X-Export-Mailbox', mboxOptions.mailboxPath, 0);
            }

            // remove existing MBOX headers
            data.headers.remove('Content-Length');
            data.headers.remove('X-Status');
            data.headers.remove('Status');
            data.headers.remove('X-GM-THRID');
            data.headers.remove('X-Gmail-Labels');

            return data.done();
        });

        sourceStream
            .pipe(headerSplitter)
            // remove 0x0D, keep 0x0A
            .pipe(newlines)
            .pipe(mboxStream)
            .pipe(outputStream, {
                end: false
            });
    });
}

module.exports = mboxExport;
