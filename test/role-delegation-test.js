'use strict';

const { expect } = require('chai');
const assert = require('assert').strict;
const { ObjectId } = require('mongodb');
const roles = require('../lib/roles');

describe('Role delegation', () => {
    const user = new ObjectId();
    const definitions = {
        delegate: {
            users: { 'update:any': ['*'] },
            userpermissions: { 'create:any': ['*'], 'update:own': ['*'] },
            messages: { 'read:any': ['*', '!internal'], 'update:own': ['subject'] },
            custom: { export: true }
        },
        user: { messages: { 'read:any': ['id'] } },
        privileged: { messages: { 'read:any': ['*'] } },
        administrator: { rolegrants: { 'update:any': ['*'] } }
    };
    const users = {
        collection(name) {
            return {
                async findOne(query) {
                    if (name === 'users') {
                        return { _id: user, role: 'delegate' };
                    }
                    const permissions = definitions[query._id];
                    return permissions ? { _id: query._id, permissions, deleted: false } : null;
                }
            };
        }
    };
    const context = permissions => roles.forUser('delegate', { permissions }, users);
    const request = role => ({
        role,
        user: user.toString(),
        validate(permission) {
            if (!permission.granted) {
                const err = new Error('Missing privileges');
                err.code = 'MissingPrivileges';
                throw err;
            }
        }
    });
    it('allows subsets with own/any inheritance, nested attributes, exclusions and custom capabilities', async () => {
        const role = await context();
        for (const permissions of [
            { messages: { 'read:own': ['id', 'subject'], 'update:own': ['subject'] }, custom: { export: true, unknown: false } },
            { messages: { 'read:any': ['*', '!internal', '!body'] } },
            { messages: { 'read:any': ['headers.subject'] } },
            {}
        ]) {
            expect(roles.canGrant(role, permissions)).to.equal(true);
        }
    });

    it('rejects wider scopes, attributes, excluded fields, new resources and custom capabilities', async () => {
        const role = await context();
        for (const permissions of [
            { messages: { 'read:any': ['*'] } },
            { messages: { 'read:any': ['internal'] } },
            { messages: { 'update:any': ['subject'] } },
            { messages: { 'update:own': ['body'] } },
            { roles: { 'update:any': ['*'] } },
            { custom: { unknown: true } },
            { custom: { toString: true, constructor: true } },
            { rolegrants: { 'update:any': ['*'] } }
        ]) {
            expect(roles.canGrant(role, permissions)).to.equal(false);
        }
    });

    it('uses caller restrictions for both resource grants and custom capabilities', async () => {
        const role = await context({ messages: { read: false }, custom: { export: false } });
        for (const permissions of [{ messages: { 'read:own': ['id'] } }, { custom: { export: true } }]) {
            expect(roles.canGrant(role, permissions)).to.equal(false);
        }
    });

    it('allows unrestricted delegation only with the explicit rolegrants permission', async () => {
        const role = await roles.forUser('administrator', {}, users);
        expect(roles.canGrant(role, { arbitrary: { 'delete:any': ['*'] }, custom: { newCapability: true } })).to.equal(true);
        const restricted = await roles.forUser('administrator', { permissions: { rolegrants: { update: false } } }, users);
        expect(roles.canGrant(restricted, { arbitrary: { 'delete:any': ['*'] } })).to.equal(false);
    });

    it('requires the separate policy grant with the correct own/any scope', async () => {
        const req = request(await context());
        await roles.validatePolicyWrite(req, { role: 'user' }, { users, user });
        await roles.validatePolicyWrite(req, { role: 'user' }, { users });
        await assert.rejects(roles.validatePolicyWrite(req, { role: 'user' }, { users, user: new ObjectId() }), { code: 'MissingPrivileges' });
        const restricted = request(await context({ userpermissions: { update: false } }));
        await assert.rejects(roles.validatePolicyWrite(restricted, { permissions: null }, { users, user }), { code: 'MissingPrivileges' });
    });

    it('preserves omitted policy fields and applies the policy grant attribute filter', async () => {
        const req = request(await context());
        const permissionsOnly = { permissions: null };
        await roles.validatePolicyWrite(req, permissionsOnly, { users, user });
        expect(permissionsOnly).to.deep.equal({ permissions: null });
        const roleOnly = { role: 'user' };
        await roles.validatePolicyWrite(req, roleOnly, { users, user });
        expect(roleOnly).to.deep.equal({ role: 'user' });

        const filteredDefinitions = {
            ...definitions.delegate,
            userpermissions: { 'update:any': ['permissions'] }
        };
        const filteredUsers = {
            collection() {
                return {
                    async findOne() {
                        return { _id: 'filtered', permissions: filteredDefinitions };
                    }
                };
            }
        };
        const role = await roles.forUser('filtered', {}, filteredUsers);
        const filtered = { role: 'privileged', name: 'Allowed name' };
        await roles.validatePolicyWrite(request(role), filtered, { users, user });
        expect(filtered).to.deep.equal({ name: 'Allowed name' });
    });

    it('checks assignments, default resets and restriction removal against the caller ceiling', async () => {
        const req = request(await context({ messages: { read: false } }));
        for (const policy of [{ role: 'privileged' }, { role: null }, { permissions: null }, { permissions: {} }]) {
            await assert.rejects(roles.validatePolicyWrite(req, policy, { users, user }), { code: 'MissingPrivileges' });
        }
    });
});
