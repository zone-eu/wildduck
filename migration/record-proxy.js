'use strict';

// Recording reverse proxy for the Restify to Fastify migration golden capture.
// Sits between the test suite and the API server, streams traffic through
// unmodified, and appends every request/response pair to a JSONL file.
// Usage: node migration/record-proxy.js <listenPort> <targetPort> <outFile>
// Temporary tooling, delete after migration.

const http = require('http');
const fs = require('fs');

const listenPort = Number(process.argv[2]);
const targetPort = Number(process.argv[3]);
const outFile = process.argv[4];

if (!listenPort || !targetPort || !outFile) {
    console.error('Usage: node migration/record-proxy.js <listenPort> <targetPort> <outFile>');
    process.exit(1);
}

// cap stored bodies; streaming/SSE responses are noted as truncated
const MAX_CAPTURE = 4 * 1024 * 1024;

const out = fs.createWriteStream(outFile, { flags: 'a' });
let seq = 0;

function bodyEncode(chunks, total) {
    const buf = Buffer.concat(chunks);
    const truncated = total > buf.length;
    // keep JSON-safe: store as utf8 when it survives a roundtrip, else base64
    const utf8 = buf.toString('utf8');
    if (Buffer.from(utf8, 'utf8').equals(buf)) {
        return { text: utf8, truncated };
    }
    return { base64: buf.toString('base64'), truncated };
}

const server = http.createServer((req, res) => {
    const id = ++seq;
    const reqChunks = [];
    let reqTotal = 0;

    const proxyReq = http.request(
        {
            host: '127.0.0.1',
            port: targetPort,
            method: req.method,
            path: req.url,
            headers: req.headers
        },
        proxyRes => {
            const resChunks = [];
            let resTotal = 0;

            res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers);

            proxyRes.on('data', chunk => {
                resTotal += chunk.length;
                if (resTotal <= MAX_CAPTURE) {
                    resChunks.push(chunk);
                }
                res.write(chunk);
            });

            proxyRes.on('end', () => {
                res.end();
                out.write(
                    JSON.stringify({
                        seq: id,
                        method: req.method,
                        url: req.url,
                        reqHeaders: req.headers,
                        reqBody: bodyEncode(reqChunks, reqTotal),
                        status: proxyRes.statusCode,
                        resHeaders: proxyRes.headers,
                        resBody: bodyEncode(resChunks, resTotal)
                    }) + '\n'
                );
            });
        }
    );

    proxyReq.on('error', err => {
        out.write(JSON.stringify({ seq: id, method: req.method, url: req.url, proxyError: err.message }) + '\n');
        if (!res.headersSent) {
            res.writeHead(502);
        }
        res.end();
    });

    req.on('data', chunk => {
        reqTotal += chunk.length;
        if (reqTotal <= MAX_CAPTURE) {
            reqChunks.push(chunk);
        }
        proxyReq.write(chunk);
    });
    req.on('end', () => proxyReq.end());
    req.on('error', () => proxyReq.destroy());
});

// long-lived SSE connections must not get killed by socket timeouts
server.timeout = 0;
server.keepAliveTimeout = 0;

server.listen(listenPort, '127.0.0.1', () => {
    console.log(`recording proxy: 127.0.0.1:${listenPort} -> 127.0.0.1:${targetPort}, appending to ${outFile}`);
});
