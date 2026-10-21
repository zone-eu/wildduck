'use strict';

const os = require('os');
const fs = require('fs');
const net = require('net');
const { formatBytes } = require('../html');

const REQUIRED_MAIL_PORTS = [25, 80, 443, 143, 993, 465, 587];

function getFreeDiskBytes(targetPath = '/') {
    try {
        if (typeof fs.statfsSync === 'function') {
            let stats = fs.statfsSync(targetPath);
            return Number(stats.bavail) * Number(stats.bsize);
        }
    } catch (err) {
        // Fallback when statfsSync is unavailable
    }
    return 20 * 1024 * 1024 * 1024;
}

function defaultPortProbe(port, host = '127.0.0.1') {
    return new Promise(resolve => {
        let socket = new net.Socket();
        let settled = false;
        let finish = isAvailable => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve(isAvailable);
            }
        };

        socket.setTimeout(400);
        socket.once('connect', () => finish(false));
        socket.once('timeout', () => finish(true));
        socket.once('error', () => finish(true));
        socket.connect(port, host);
    });
}

async function runPreflightChecks(options = {}) {
    let sys = options.systemInfo || {
        platform: os.platform(),
        release: os.release(),
        nodeVersion: process.version,
        totalMemBytes: os.totalmem(),
        cpuCores: (os.cpus() || []).length || 1,
        freeDiskBytes: getFreeDiskBytes(options.diskPath || '/')
    };

    let portProbe = options.portProbe || defaultPortProbe;
    let portsToCheck = options.ports || REQUIRED_MAIL_PORTS;

    let checks = [];

    // 1. OS & Node.js Runtime Check
    let nodeMajor = Number(String(sys.nodeVersion).replace(/^v/, '').split('.')[0]) || 0;
    let osStatus = sys.platform === 'linux' && nodeMajor >= 22 ? 'pass' : nodeMajor >= 18 ? 'warn' : 'fail';
    checks.push({
        id: 'os',
        labelKey: 'installer.checkOs',
        status: osStatus,
        value: `${sys.platform} (${sys.release}) / Node ${sys.nodeVersion}`,
        detail: 'Recommended: Linux Ubuntu/Debian with Node.js >= 22.19.0'
    });

    // 2. System RAM Check
    let ramMb = Math.round(sys.totalMemBytes / (1024 * 1024));
    let ramStatus = ramMb >= 1024 ? 'pass' : ramMb >= 512 ? 'warn' : 'fail';
    checks.push({
        id: 'ram',
        labelKey: 'installer.checkRam',
        status: ramStatus,
        value: formatBytes(sys.totalMemBytes),
        detail: 'Recommended: >= 1.0 GB RAM (vs 16+ GB required by legacy Java mail suites)'
    });

    // 3. CPU Cores Check
    let cpuStatus = sys.cpuCores >= 2 ? 'pass' : 'warn';
    checks.push({
        id: 'cpu',
        labelKey: 'installer.checkCpu',
        status: cpuStatus,
        value: `${sys.cpuCores} core(s)`,
        detail: 'Recommended: >= 2 vCPU cores for concurrent IMAP and MIME indexing'
    });

    // 4. Available Disk Storage Check
    let diskGb = sys.freeDiskBytes / (1024 * 1024 * 1024);
    let diskStatus = diskGb >= 5 ? 'pass' : diskGb >= 1 ? 'warn' : 'fail';
    checks.push({
        id: 'disk',
        labelKey: 'installer.checkDisk',
        status: diskStatus,
        value: formatBytes(sys.freeDiskBytes),
        detail: 'Recommended: >= 5.0 GB free disk space for MongoDB mail store'
    });

    // 5. Mail & Web Ports Availability
    let occupiedPorts = [];
    for (let port of portsToCheck) {
        let free = await portProbe(port);
        if (!free) {
            occupiedPorts.push(port);
        }
    }

    let portStatus = occupiedPorts.length === 0 ? 'pass' : 'warn';
    checks.push({
        id: 'ports',
        labelKey: 'installer.checkPorts',
        status: portStatus,
        occupiedPorts,
        value:
            occupiedPorts.length === 0
                ? `All ${portsToCheck.length} ports available (${portsToCheck.join(', ')})`
                : `Active listeners on port(s): ${occupiedPorts.join(', ')}`,
        detail: 'Ports 25 (SMTP), 80/443 (HTTP/S), 143/993 (IMAP), 465/587 (Submission)'
    });

    let hasFatalFailure = checks.some(c => c.status === 'fail');

    return {
        ready: !hasFatalFailure,
        checkedAt: new Date().toISOString(),
        checks
    };
}

module.exports = {
    REQUIRED_MAIL_PORTS,
    runPreflightChecks
};
