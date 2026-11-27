/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

const { expect } = require('chai');
const { spawnSync } = require('child_process');
const path = require('path');

describe('UserHandler module loading', function () {
    for (const configSetup of ['delete config.api', 'config.api = {}']) {
        it(`should load when ${configSetup}`, function () {
            const userHandlerPath = path.resolve(__dirname, '../lib/user-handler.js');
            const source = `
                const config = require('@zone-eu/wild-config');
                ${configSetup};
                require(${JSON.stringify(userHandlerPath)});
            `;

            const result = spawnSync(process.execPath, ['-e', source], {
                cwd: path.resolve(__dirname, '..'),
                encoding: 'utf8',
                timeout: 10000
            });

            expect(result.error, 'child process should complete without an execution error').to.equal(undefined);
            expect(result.status, result.stderr).to.equal(0);
        });
    }
});
