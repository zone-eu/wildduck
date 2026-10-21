'use strict';

const dnsPromises = require('dns').promises;

function normalizeDnsHost(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\.$/, '');
}

function buildRequiredDnsRecords(params = {}) {
    let mailDomain = normalizeDnsHost(params.mailDomain || 'example.com');
    let hostname = normalizeDnsHost(params.hostname || `mail.${mailDomain}`);
    let publicIp = String(params.publicIp || '127.0.0.1').trim();
    let dkimSelector = normalizeDnsHost(params.dkimSelector || 'wd2026');
    let rawDkimKey = String(params.dkimPublicKey || 'GENERATE_ON_PROVISION')
        .replace(/-----BEGIN PUBLIC KEY-----/g, '')
        .replace(/-----END PUBLIC KEY-----/g, '')
        .replace(/\s+/g, '');

    return [
        {
            id: 'a',
            type: 'A',
            host: hostname,
            expected: publicIp,
            description: 'Points mail server hostname to your server public IPv4 address'
        },
        {
            id: 'mx',
            type: 'MX',
            host: mailDomain,
            expected: hostname,
            priority: 10,
            description: 'Directs incoming email for your domain to your mail server hostname'
        },
        {
            id: 'spf',
            type: 'TXT',
            host: mailDomain,
            expected: `v=spf1 mx a:${hostname} -all`,
            description: 'Authorizes your mail server to send email on behalf of your domain (SPF)'
        },
        {
            id: 'dkim',
            type: 'TXT',
            host: `${dkimSelector}._domainkey.${mailDomain}`,
            expected: `v=DKIM1; k=rsa; p=${rawDkimKey}`,
            description: 'Cryptographic public key used by recipients to verify DKIM signatures'
        },
        {
            id: 'dmarc',
            type: 'TXT',
            host: `_dmarc.${mailDomain}`,
            expected: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${mailDomain}`,
            description: 'Instructs receiving servers how to handle SPF/DKIM alignment failures (DMARC)'
        },
        {
            id: 'ptr',
            type: 'PTR',
            host: publicIp,
            expected: hostname,
            description: 'Reverse DNS (rDNS) matching your IP to your hostname for high deliverability'
        }
    ];
}

async function verifyDnsRecords(params = {}, customResolver = null) {
    let resolver = customResolver || dnsPromises;
    let records = buildRequiredDnsRecords(params);
    let results = [];

    for (let record of records) {
        let entry = {
            ...record,
            actual: [],
            status: 'fail'
        };

        try {
            if (record.id === 'a') {
                let ips = await resolver.resolve4(record.host);
                entry.actual = ips || [];
                entry.status = entry.actual.includes(record.expected) ? 'pass' : 'fail';
            } else if (record.id === 'mx') {
                let mxList = await resolver.resolveMx(record.host);
                entry.actual = (mxList || []).map(item => normalizeDnsHost(item.exchange));
                entry.status = entry.actual.includes(record.expected) ? 'pass' : 'fail';
            } else if (record.id === 'spf') {
                let txtChunks = await resolver.resolveTxt(record.host);
                let flat = (txtChunks || []).map(parts => parts.join(''));
                entry.actual = flat.filter(val => val.toLowerCase().startsWith('v=spf1'));
                entry.status = entry.actual.some(val => val.includes(record.expected) || val.includes(`a:${params.hostname}`)) ? 'pass' : 'fail';
            } else if (record.id === 'dkim') {
                let txtChunks = await resolver.resolveTxt(record.host);
                let flat = (txtChunks || []).map(parts => parts.join(''));
                entry.actual = flat;
                let expectedKeyPart = record.expected.split('p=')[1] || '';
                entry.status = flat.some(val => val.includes('v=DKIM1') && (!expectedKeyPart || val.includes(expectedKeyPart))) ? 'pass' : 'fail';
            } else if (record.id === 'dmarc') {
                let txtChunks = await resolver.resolveTxt(record.host);
                let flat = (txtChunks || []).map(parts => parts.join(''));
                entry.actual = flat;
                entry.status = flat.some(val => val.toLowerCase().startsWith('v=dmarc1')) ? 'pass' : 'warn';
            } else if (record.id === 'ptr') {
                let hostnames = await resolver.reverse(record.host);
                entry.actual = (hostnames || []).map(h => normalizeDnsHost(h));
                entry.status = entry.actual.includes(record.expected) ? 'pass' : 'warn';
            }
        } catch (err) {
            entry.actual = [];
            entry.error = err.code || err.message;
            entry.status = record.id === 'ptr' || record.id === 'dmarc' ? 'warn' : 'fail';
        }

        results.push(entry);
    }

    let allPassed = results.every(r => r.status === 'pass');

    return {
        checkedAt: new Date().toISOString(),
        allPassed,
        records: results
    };
}

module.exports = {
    buildRequiredDnsRecords,
    verifyDnsRecords
};
