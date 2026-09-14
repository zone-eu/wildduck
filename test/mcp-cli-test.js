'use strict';

const chai = require('chai');
const { buildParser } = require('../bin/mcp-tokens');

const expect = chai.expect;

describe('MCP token CLI', () => {
    it('loads the yargs command parser with all commands', async () => {
        let parser = buildParser([]);
        let help = await parser.getHelp();

        expect(help).to.include('mcp-tokens create <user>');
        expect(help).to.include('mcp-tokens list <user>');
        expect(help).to.include('mcp-tokens revoke <user> <token>');
    });

    it('rejects an empty description before opening database connections', async () => {
        let connections = 0;
        let parser = buildParser(['create', 'alice', '--description', ''], {
            connect: async () => {
                connections++;
            }
        });
        let thrown;
        try {
            await parser.parseAsync();
        } catch (err) {
            thrown = err;
        }

        expect(thrown).to.be.instanceOf(Error);
        expect(thrown.message).to.include('Description must not be empty');
        expect(connections).to.equal(0);
    });

    it('runs create, list, and revoke through the same direct handler interface', async () => {
        const userId = '507f191e810c19729de860ea';
        const tokenId = '507f1f77bcf86cd799439011';
        let calls = [];
        let output = [];
        let handler = {
            async resolveUser(value) {
                calls.push(['resolveUser', value]);
                return { _id: { toString: () => userId } };
            },
            async create(user, data) {
                calls.push(['create', user.toString(), data]);
                return { id: tokenId, token: `wdmcp_${'a'.repeat(64)}` };
            },
            async list(user) {
                calls.push(['list', user.toString()]);
                return [{ id: tokenId }];
            },
            async revoke(user, token) {
                calls.push(['revoke', user.toString(), token]);
            }
        };
        let dependencies = { connect: async () => handler, print: value => output.push(value) };

        await buildParser(['create', 'alice@example.com', '--description', 'Codex', '--expires', '2027-01-01T00:00:00Z'], dependencies).parseAsync();
        await buildParser(['list', 'alice'], dependencies).parseAsync();
        await buildParser(['revoke', userId, tokenId], dependencies).parseAsync();

        expect(calls).to.deep.equal([
            ['resolveUser', 'alice@example.com'],
            ['create', userId, { description: 'Codex', expires: '2027-01-01T00:00:00Z' }],
            ['resolveUser', 'alice'],
            ['list', userId],
            ['resolveUser', userId],
            ['revoke', userId, tokenId]
        ]);
        expect(output).to.have.length(3);
        expect(output[0]).to.include({ user: userId, id: tokenId });
        expect(output[1]).to.deep.equal({ user: userId, results: [{ id: tokenId }] });
        expect(output[2]).to.deep.equal({ success: true, user: userId, id: tokenId });
    });
});
