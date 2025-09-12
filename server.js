/* eslint global-require:0 */

'use strict';

process.env.UV_THREADPOOL_SIZE = 16;
process.binding('http_parser').HTTPParser = require('http-parser-js').HTTPParser;

const v8 = require('node:v8');
const Path = require('path');
const os = require('os');
const config = require('wild-config');

if (process.env.NODE_CONFIG_ONLY === 'true') {
    console.log(require('util').inspect(config, false, 22)); // eslint-disable-line
    return process.exit();
}

const errors = require('./lib/errors');
const fs = require('fs');
const log = require('npmlog');
const packageData = require('./package.json');
const { init: initElasticSearch } = require('./lib/elasticsearch');

log.level = config.log.level;

const printLogo = () => {
    let logo = fs
        .readFileSync(__dirname + '/logo.txt', 'utf-8')
        .replace(/^\n+|\n+$/g, '')
        .split('\n');

    let columnLength = logo.map(l => l.length).reduce((max, val) => (val > max ? val : max), 0);
    let versionString = ' ' + packageData.name + '@' + packageData.version + ' ';
    let versionPrefix = '-'.repeat(Math.round(columnLength / 2 - versionString.length / 2));
    let versionSuffix = '-'.repeat(columnLength - versionPrefix.length - versionString.length);

    log.info('App', ' ' + '-'.repeat(columnLength));
    log.info('App', '');

    logo.forEach(line => {
        log.info('App', ' ' + line);
    });

    log.info('App', '');

    log.info('App', ' ' + versionPrefix + versionString + versionSuffix);
    log.info('App', '');
};

let processCount = config.processes;
if (processCount) {
    if (/^\s*cpus\s*$/i.test(processCount)) {
        processCount = os.cpus().length;
    }

    if (typeof processCount !== 'number' && !isNaN(processCount)) {
        processCount = Number(processCount);
    }

    if (isNaN(processCount)) {
        processCount = 1;
    }
}

if (!processCount || processCount <= 1) {
    printLogo();
    if (config.ident) {
        process.title = config.ident;
    }
    // single process mode, do not fork anything

    initElasticSearch()
        .then(started => {
            if (started) {
                log.verbose('App', `ElasticSearch setup checked`);
            }
        })
        .catch(err => {
            log.error('App', `ElasticSearch setup failed: ${err.message}${err.meta?.statusCode ? ` (${err.meta?.statusCode})` : ''}`);
        })
        .finally(() => {
            require('./worker.js');
        });
} else {
    let cluster = require('cluster');

    if (cluster.isMaster) {
        printLogo();

        if (config.ident) {
            process.title = config.ident + ' master';
        }

        log.info('App', `Master [${process.pid}] is running`);

        let workers = new Set();

        let forkWorker = () => {
            let worker = cluster.fork();
            workers.add(worker);
            log.info('App', `Forked worker ${worker.process.pid}`);
        };

        // Fork workers.
        initElasticSearch()
            .then(started => {
                if (started) {
                    log.verbose('App', `ElasticSearch setup checked`);
                }
            })
            .catch(err => {
                log.error('App', `ElasticSearch setup failed: ${err.message}${err.meta?.statusCode ? ` (${err.meta?.statusCode})` : ''}`);
            })
            .finally(() => {
                for (let i = 0; i < processCount; i++) {
                    forkWorker();
                }
            });

        cluster.on('exit', worker => {
            log.info('App', `Worker ${worker.process.pid} died`);
            workers.delete(worker);
            setTimeout(forkWorker, 1000);
        });

        config.on('reload', () => {
            workers.forEach(child => {
                try {
                    child.kill('SIGHUP');
                } catch (E) {
                    //ignore
                }
            });
        });
    } else {
        if (config.ident) {
            process.title = config.ident + ' worker';
        }

        require('./worker.js');
    }
}

process.on('unhandledRejection', err => {
    log.error('App', 'Unhandled rejection: %s', (err && err.stack) || err);
    errors.notify(err);
});

process.on('SIGHUP', () => {
    // generate memory dump
    log.info('Process', 'PID=%s Generating heap snapshot...', process.pid);
    let stream;

    try {
        stream = v8.getHeapSnapshot();
    } catch (err) {
        log.error('Process', 'PID=%s Failed to generate heap snapshot: %s', process.pid, err.stack || err);
        return;
    }

    if (stream) {
        const path = Path.join(
            os.tmpdir(),
            `Heap-${process.pid}-${new Date()
                .toISOString()
                .substring(0, 19)
                .replace(/[^0-9T]+/g, '')}.heapsnapshot`
        );

        let f;
        try {
            f = fs.createWriteStream(path);
        } catch (err) {
            log.error('Process', 'PID=%s Failed to generate heap snapshot: %s', process.pid, err.stack || err);
            return;
        }

        f.once('error', err => {
            log.error('Process', 'PID=%s Failed to generate heap snapshot: %s', process.pid, err.stack || err);
        });
        stream.once('error', err => {
            log.error('Process', 'PID=%s Failed to generate heap snapshot: %s', process.pid, err.stack || err);
        });
        stream.pipe(f);
        f.once('finish', () => {
            log.info('Process', 'PID=%s Generated heap snapshot: %s', process.pid, path);
        });
    }
});
