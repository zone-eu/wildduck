'use strict';

const supertest = require('supertest');
const fs = require('fs');

const config = require('@zone-eu/wild-config');

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

const titles = [];
const unsupportedTitles = [];

// global beforeEach to run before EVERY test
beforeEach('Get test data before each test', async function () {
    const currentTestTitle = this.test.ctx.currentTest.title; // eslint-disable-line no-invalid-this
    if (/\b(POST|PUT|DELETE|GET)\b/i.test(currentTestTitle) && /success|failure/.test(currentTestTitle)) {
        titles.push(currentTestTitle);
    } else {
        unsupportedTitles.push(currentTestTitle);
    }
});

// eslint-disable-next-line no-undef
after('Generate test overview table after all tests', async () => {
    const data = await server.get('/api-methods');

    const routes = data.body;

    const mapApiMethodToSpec = {};
    let content = '| API path | API method | Test count | Has positive test? | Has Negative test? |\n';
    content += '| --- | :---: | --- | --- | --- | \n';

    for (const routeName in routes) {
        const route = routes[routeName];
        const method = route.spec.method;
        const path = route.spec.path;

        mapApiMethodToSpec[`${method.toLowerCase()}_${path}`] = {
            method,
            path,
            name: route.spec.name || route.name,
            testCount: 0,
            positiveTestCount: 0,
            negativeTestCount: 0
        };
    }

    for (const title of titles) {
        const titleSplit = title.split(/\s+/);
        const method = titleSplit[1].toLowerCase();
        const path = titleSplit[2];
        const expectedResult = titleSplit[4];

        // missing method or path (string is too short to be accepted as valid test title)
        if (!method || !path) {
            continue;
        }

        const data = mapApiMethodToSpec[`${method}_${path.replace(/{/g, ':').replace(/}/g, '')}`];

        // wrong path or wrong data etc. (no such route, can't construct route from test title)
        if (!data) {
            unsupportedTitles.push(title);
            continue;
        }

        data.testCount++;
        if (expectedResult) {
            if (expectedResult === 'success') {
                data.positiveTestCount++;
            } else if (expectedResult === 'failure') {
                data.negativeTestCount++;
            }
        }
    }

    const sortedData = Object.values(mapApiMethodToSpec).sort((a, b) => {
        // 1) sort by test count
        // 2) sort by path

        if (a.testCount < b.testCount) {
            return 1;
        } else if (a.testCount > b.testCount) {
            return -1;
        } else if (a.path > b.path) {
            return 1;
        } else if (a.path < b.path) {
            return -1;
        } else {
            return 0;
        }
    });

    for (const data of sortedData) {
        content += `| \`${data.path}\` | \`${data.method}\` | ${data.testCount} | ${data.positiveTestCount > 0 ? '✅' : '❌'} (${data.positiveTestCount}) | ${
            data.negativeTestCount > 0 ? '✅' : '❌'
        } (${data.negativeTestCount}) |\n`;
    }

    console.log(__dirname);
    await fs.promises.writeFile(__dirname + '/../api-tests-overview.md', content);

    console.log('These titles were not included in the overview as they are wrong format:', unsupportedTitles);
});
