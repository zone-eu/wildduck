'use strict';

process.env.NODE_ENV = 'test';

module.exports = function (grunt) {
    // Project configuration.
    grunt.initConfig({
        eslint: {
            all: ['lib/**/*.js', 'imap-core/**/*.js', 'test/**/*.js', 'examples/**/*.js', 'Gruntfile.js']
        },

        mochaTest: {
            imap: {
                options: {
                    reporter: 'spec'
                },
                // imap-core tests (all)
                src: ['imap-core/test/**/*-test.js']
            },
            'imap-unit': {
                options: {
                    reporter: 'spec'
                },
                // imap-core unit tests (no MongoDB required)
                src: [
                    'imap-core/test/compress-race-condition-test.js',
                    'imap-core/test/imap-compile-stream-test.js',
                    'imap-core/test/imap-compiler-test.js',
                    'imap-core/test/imap-indexer-test.js',
                    'imap-core/test/imap-parser-test.js',
                    'imap-core/test/onconnect-test.js',
                    'imap-core/test/parse-mime-tree-test.js',
                    'imap-core/test/search-test.js',
                    'imap-core/test/tools-test.js'
                ]
            },
            pop3: {
                options: {
                    reporter: 'spec'
                },
                // pop3 tests (do not require server/db)
                src: ['test/pop3-*-test.js']
            },
            api: {
                options: {
                    reporter: 'spec'
                },
                // api tests
                src: ['test/**/*-test.js']
            }
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
            options: {
                stdout: data => console.log(data.toString().trim()),
                stderr: data => console.log(data.toString().trim()),
                failOnError: true
            }
        }
    });

    // Load the plugin(s)
    grunt.loadNpmTasks('grunt-eslint');
    grunt.loadNpmTasks('grunt-mocha-test');
    grunt.loadNpmTasks('grunt-shell-spawn');
    grunt.loadNpmTasks('grunt-wait');

    // Tasks
    grunt.registerTask('default', ['eslint', 'shell:server', 'wait:server', 'mochaTest', 'shell:server:kill']);
    grunt.registerTask('testonly', ['shell:server', 'wait:server', 'mochaTest', 'shell:server:kill']);
    // proto: run all protocol-level tests (IMAP unit + POP3) without requiring MongoDB/Redis
    grunt.registerTask('proto', ['mochaTest:imap-unit', 'mochaTest:pop3']);
};
