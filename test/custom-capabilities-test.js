'use strict';

const chai = require('chai');
const AccessControl = require('accesscontrol');
const config = require('@zone-eu/wild-config');
const RoleHandler = require('../lib/role-handler');
const roles = require('../lib/roles');

const expect = chai.expect;

function fakeUsers(roleRecords) {
    return {
        collection(name) {
            if (name !== 'roles') {
                throw new Error(`Unexpected collection ${name}`);
            }
            return {
                async findOne(query) {
                    return roleRecords[query._id] || null;
                }
            };
        }
    };
}

function record(name, permissions) {
    return { _id: name, name, permissions, deleted: false, isSystem: false };
}

describe('custom capabilities', () => {
    const capabilityRole = 'test:custom-capabilities';
    const definition = {
        users: { 'read:own': ['*'] },
        messages: { 'read:any': ['subject'] },
        labels: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
        custom: { export: true, manageBilling: false }
    };
    const roleUsers = fakeUsers({
        user: record('user', config.api.roles.user),
        'mcp:read': record('mcp:read', config.api.roles['mcp:read']),
        [capabilityRole]: record(capabilityRole, definition)
    });

    it('retains resources and validates custom grant and restriction maps', () => {
        expect(RoleHandler.resourceGrants(definition)).to.deep.equal({ users: definition.users, messages: definition.messages, labels: definition.labels });
        expect(() => RoleHandler.validateGrants({ custom: { export: true, beta: false } })).not.to.throw();
        expect(() => RoleHandler.validateRestrictions({ custom: { export: false, beta: true } })).not.to.throw();

        for (const custom of [null, [], { bad: 'true' }, { bad: 1 }]) {
            expect(() => RoleHandler.validateGrants({ custom })).to.throw();
            expect(() => RoleHandler.validateRestrictions({ custom })).to.throw();
        }
    });

    it('applies custom denies without allowing user true values to grant capabilities', async () => {
        const base = await roles.forUser(capabilityRole, {}, roleUsers);
        const denied = await roles.forUser(capabilityRole, { permissions: { custom: { export: false, manageBilling: true, unknown: true } } }, roleUsers);
        const effective = roles.getEffectivePermissions(denied);

        expect(roles.getEffectivePermissions(base).custom).to.deep.equal({ export: true, manageBilling: false });
        expect(effective.custom).to.deep.equal({ export: false, manageBilling: false });
        expect(effective.resources.messages).to.have.property('read:any', true);
        expect(effective.resources).not.to.have.property('unlisted');
        expect(effective.custom).not.to.have.property('unknown');
    });

    it('derives all eight effective CRUD values from accesscontrol, including Any to Own', async () => {
        const context = await roles.forUser(capabilityRole, {}, roleUsers);
        const expected = new AccessControl({ snapshot: RoleHandler.resourceGrants(definition) }).can('snapshot');
        const actual = roles.getEffectivePermissions(context);

        for (const resource of Object.keys(RoleHandler.resourceGrants(definition))) {
            for (const operation of ['create', 'read', 'update', 'delete']) {
                for (const possession of ['Own', 'Any']) {
                    const key = `${operation}:${possession.toLowerCase()}`;
                    expect(actual.resources[resource][key]).to.equal(expected[`${operation}${possession}`](resource).granted);
                }
            }
        }
        expect(actual.resources.labels['create:own']).to.equal(true);
        expect(actual.resources.labels['delete:own']).to.equal(true);
    });

    it('keeps request snapshots stable and honors explicit token roles with account restrictions', async () => {
        const mutable = record(capabilityRole, definition);
        const snapshotUsers = fakeUsers({ [capabilityRole]: mutable, user: record('user', config.api.roles.user) });
        const admitted = await roles.forUser(capabilityRole, { permissions: { custom: { export: false } } }, snapshotUsers);
        mutable.permissions = {};
        expect(roles.getEffectivePermissions(admitted).custom.export).to.equal(false);

        const explicit = await roles.forUser('mcp:read', { role: capabilityRole, permissions: { custom: { export: true } } }, roleUsers);
        expect(String(explicit)).to.equal('mcp:read');
        expect(roles.getEffectivePermissions(explicit).custom).to.deep.equal({});
        expect(roles.can(explicit).readOwn('messages').granted).to.equal(true);
        expect(roles.can(explicit).createOwn('messages').granted).to.equal(false);
    });

    it('returns effective permissions only for own policy and still applies read grants and field allowlists', async () => {
        const ownId = '507f191e810c19729de860ea';
        const userData = { _id: ownId, role: capabilityRole, permissions: { custom: { export: false } }, secret: 'hidden' };
        const ownRole = await roles.forUser('user', userData, roleUsers);
        const own = roles.getPolicyResponse({ role: ownRole, user: ownId }, userData);
        expect(own).to.have.property('effectivePermissions');
        expect(own.effectivePermissions.custom.export).to.equal(false);
        expect(own).not.to.have.property('secret');

        const any = roles.getPolicyResponse({ role: 'root', user: 'another-user' }, userData);
        expect(any).not.to.have.property('effectivePermissions');
        expect(any).not.to.have.property('secret');
        expect(roles.getPolicyResponse({ role: 'tokenAuth', user: ownId }, userData)).to.deep.equal({});
        const limitedUsers = fakeUsers({
            limited: record('limited', { users: { 'read:own': ['role', 'permissions'] }, custom: { export: true } })
        });
        const limitedRole = await roles.forUser('limited', {}, limitedUsers);
        expect(roles.getPolicyResponse({ role: limitedRole, user: ownId }, userData)).to.deep.equal({
            role: userData.role,
            permissions: userData.permissions
        });
    });
});
