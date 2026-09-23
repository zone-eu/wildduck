'use strict';

process.env.NODE_ENV = 'test';

module.exports = function (grunt) {
    const mocha = 'npx mocha --reporter spec --color --exit';
    const mochaOutput = {
        stdout: true,
        stderr: true
    };
    const imapUnitTests = [
        'imap-core/test/compress-race-condition-test.js',
        'imap-core/test/imap-compile-stream-test.js',
        'imap-core/test/imap-compiler-test.js',
        'imap-core/test/imap-indexer-test.js',
        'imap-core/test/imap-parser-test.js',
        'imap-core/test/onconnect-test.js',
        'imap-core/test/parse-mime-tree-test.js',
        'imap-core/test/search-test.js',
        'imap-core/test/tools-test.js'
    ];
    const unitTests = [
        'test/certs-test.js',
        'test/checkrangequery-test.js',
        'test/create-decipher-test.js',
        'test/filtering-tools-test.js',
        'test/hibp-tools-test.js',
        'test/list-headers-test.js',
        'test/maildropper-test.js',
        'test/message-handler-update-test.js',
        'test/mcp-api-client-test.js',
        'test/mcp-cli-test.js',
        'test/mcp-html-test.js',
        'test/mcp-test.js',
        'test/mcp-token-handler-test.js',
        'test/mcp-tools-test.js',
        'test/metrics-config-test.js',
        'test/prometheus-test.js',
        'test/roles-test.js',
        'test/tools-test.js'
    ];

    // Project configuration.
    grunt.initConfig({
        eslint: {
            all: ['*.js', 'lib/**/*.js', 'imap-core/**/*.js', 'test/**/*.js', 'examples/**/*.js', 'bin/*']
        },

        wait: {
            server: {
                options: {
                    delay: 12 * 1000
                }
            }
        },

        shell: {
            server: {
                command: 'node server.js',
                options: {
                    async: true
                }
            },
            'mocha-imap': {
                command: `${mocha} "imap-core/test/**/*-test.js"`,
                options: mochaOutput
            },
            'mocha-imap-unit': {
                command: `${mocha} ${imapUnitTests.join(' ')}`,
                options: mochaOutput
            },
            'mocha-pop3': {
                command: `${mocha} "test/pop3-*-test.js"`,
                options: mochaOutput
            },
            'mocha-unit': {
                command: `${mocha} ${unitTests.join(' ')}`,
                options: mochaOutput
            },
            'mocha-api': {
                command: `${mocha} "test/**/*-test.js"`,
                options: mochaOutput
            },
            options: {
                stdout: data => console.log(data.toString().trim()),
                stderr: data => console.log(data.toString().trim()),
                failOnError: true
            }
        }
    });

    // Load the plugin(s)
    grunt.loadNpmTasks('grunt-eslint');
    grunt.loadNpmTasks('grunt-shell-spawn');
    grunt.loadNpmTasks('grunt-wait');

    // Tasks
    const mochaTests = ['shell:mocha-imap', 'shell:mocha-imap-unit', 'shell:mocha-pop3', 'shell:mocha-unit', 'shell:mocha-api'];
    grunt.registerTask('default', ['eslint', 'shell:server', 'wait:server', ...mochaTests, 'shell:server:kill']);
    grunt.registerTask('testonly', ['shell:server', 'wait:server', ...mochaTests, 'shell:server:kill']);
    // proto: run all protocol-level tests (IMAP unit + POP3 + unit) without requiring MongoDB/Redis
    grunt.registerTask('proto', ['shell:mocha-imap-unit', 'shell:mocha-pop3', 'shell:mocha-unit']);
};
