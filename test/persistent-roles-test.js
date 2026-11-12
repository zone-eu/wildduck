'use strict';

/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

const chai = require('chai');
const { ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const db = require('../lib/db');
const RoleHandler = require('../lib/role-handler');
const roleAccess = require('../lib/roles');
const roleDelete = require('../lib/tasks/role-delete');
const assert = require('assert').strict;
const { connect, uniqueName } = require('./api/_helpers');

const expect = chai.expect;
const definitions = config.api.roles;

function collectionNameFor(name, testCollection) {
    if (name === 'roles') {
        return testCollection;
    }
    if (name === 'users') {
        return `${testCollection}_users`;
    }
    return name;
}

describe('persistent roles', function () {
    this.timeout(30000); // eslint-disable-line no-invalid-this

    let handler;
    let roles;
    let usersDb;
    let database;
    const collectionName = uniqueName('roles');

    before(async function () {
        await connect();
        usersDb = {
            collection(name) {
                return db.users.collection(collectionNameFor(name, collectionName));
            }
        };
        database = {
            collection(name) {
                if (name === 'tasks') {
                    return db.database.collection(`${collectionName}_tasks`);
                }
                return db.database.collection(name);
            }
        };
        roles = db.users.collection(collectionName);
        handler = new RoleHandler({ users: usersDb, database });
    });

    after(async function () {
        if (roles) {
            await roles.drop().catch(() => false);
            await usersDb.collection('users').drop().catch(() => false);
            await db.database.collection(`${collectionName}_tasks`).drop().catch(() => false);
        }
    });

    it('seeds source roles once and preserves names and timestamps on repeated concurrent initialization', async function () {
        await Promise.all([handler.initialize(), handler.initialize(), handler.initialize()]);
        const first = await roles.find({}).sort({ name: 1 }).toArray();
        expect(first).to.have.length(Object.keys(definitions).length);
        const root = first.find(role => role.name === 'root');
        expect(root).to.exist;
        const snapshot = first.map(({ _id, name, created, updated, permissions }) => ({ _id, name, created, updated, permissions }));

        await Promise.all([handler.initialize(), handler.initialize()]);
        const second = await roles.find({}).sort({ name: 1 }).toArray();
        const actual = second.map(({ _id, name, created, updated, permissions }) => ({ _id, name, created, updated, permissions }));
        expect(actual).to.deep.equal(snapshot);
    });

    it('loads source roles added through the effective configuration', async function () {
        const roleName = uniqueName('configured');
        config.api.roles[roleName] = { customResource: { 'read:any': ['*'] } };

        try {
            const defaultHandler = new RoleHandler({ users: usersDb, database });
            await defaultHandler.initialize();

            const configuredRole = await roles.findOne({ _id: roleName });
            expect(configuredRole).to.include({ _id: roleName, name: roleName, isSystem: true });
            expect(configuredRole.permissions).to.deep.equal(config.api.roles[roleName]);
        } finally {
            delete config.api.roles[roleName];
            await roles.deleteOne({ _id: roleName });
        }
    });

    it('keeps custom roles across initialization and restores modified or deleted system roles', async function () {
        const custom = await handler.create({
            name: uniqueName('custom'),
            description: 'kept',
            permissions: {
                users: { 'read:any': ['id'] }
            }
        });
        const rootId = 'root';
        const original = await handler.get(rootId);
        const originalCreated = original.created;

        await roles.updateOne(
            { _id: rootId },
            {
                $set: {
                    isSystem: false,
                    permissions: {},
                    description: 'tampered'
                }
            }
        );

        await handler.initialize();

        const restored = await handler.get(rootId);
        expect(restored._id).to.equal(rootId);
        expect(restored.created).to.deep.equal(originalCreated);
        expect(restored.permissions).to.deep.equal(original.permissions);
        expect(restored.name).to.equal('root');
        expect(restored.isSystem).to.equal(true);
        expect(await handler.get(custom._id)).to.exist;

        await roles.deleteOne({ _id: rootId });
        await handler.initialize();

        const recreated = await handler.get(rootId);
        expect(recreated._id).to.equal(rootId);
        expect(recreated.name).to.equal('root');
        expect(recreated.created).to.be.instanceOf(Date);
    });

    it('initializes arbitrary source definitions and protects their seeded rows while isSystem is true', async function () {
        const additionalName = uniqueName('system');
        const extended = new RoleHandler({
            users: usersDb,
            database,
            definitions: {
                [additionalName]: {
                    newResource: { 'read:any': ['*'] }
                }
            }
        });

        await extended.initialize();

        const role = await extended.get(additionalName);
        expect(role).to.exist;

        await expectCode(extended.update(role._id, { description: 'no', permissions: {} }), 'SystemRoleProtected');
        await expectCode(extended.delete(role._id), 'SystemRoleProtected');
        await expectCode(handler.update('root', { description: 'blocked' }), 'SystemRoleProtected');
    });

    it('uses only the stored system flag for protection and restores source rows on initialization', async function () {
        for (const name of Object.keys(definitions)) {
            await expectCode(handler.update(name, { permissions: {} }), 'SystemRoleProtected');
            await expectCode(handler.delete(name), 'SystemRoleProtected');
        }

        await roles.updateOne({ _id: 'root' }, { $set: { isSystem: false, name: 'tampered-root' } });
        const changed = await handler.update('root', { description: 'temporarily unprotected' });
        expect(changed.description).to.equal('temporarily unprotected');

        const assignedUserId = new ObjectId();
        await usersDb.collection('users').insertOne({ _id: assignedUserId, role: 'root' });
        expect(await handler.delete('root')).to.equal(true);

        const custom = await handler.create({ name: uniqueName('system-flag'), permissions: {} });
        await roles.updateOne({ _id: custom.name }, { $set: { isSystem: true } });
        await expectCode(handler.update(custom.name, { description: 'blocked' }), 'SystemRoleProtected');
        await expectCode(handler.delete(custom.name), 'SystemRoleProtected');

        await handler.initialize();
        const restored = await handler.get('root');
        expect(restored.name).to.equal('root');
        expect(restored.isSystem).to.equal(true);

        expect((await roleDelete.run({}, { role: 'root' }, {}, usersDb)).updated).to.equal(0);
        expect((await usersDb.collection('users').findOne({ _id: assignedUserId })).role).to.equal('root');
    });

    it('rejects conflicting source names before accepting them', async function () {
        const id = 'user';
        const original = await handler.get(id);
        await roles.deleteOne({ _id: id });
        await roles.insertOne({ _id: id, name: id, permissions: {}, isSystem: false, deleted: false });

        await expectCode(handler.initialize(), 'RoleIdentityConflict');

        await roles.deleteOne({ _id: id });
        await roles.insertOne(original);

        const arbitrary = new RoleHandler({
            users: usersDb,
            database,
            definitions: {
                onlyThis: {
                    anotherNewResource: { 'read:any': ['*'] }
                }
            }
        });

        await arbitrary.initialize();
        expect(await roles.findOne({ _id: 'onlyThis', name: 'onlyThis' })).to.exist;
    });

    it('keeps snapshots stable while subsequent requests observe grant changes and database errors fail closed', async function () {
        const role = await handler.create({
            name: uniqueName('snapshot'),
            permissions: {
                users: { 'read:any': ['id'] }
            }
        });
        const admitted = await roleAccess.forUser(role.name, {}, usersDb);
        expect(roleAccess.can(admitted).readAny('users').attributes).to.deep.equal(['id']);

        await handler.update(role.name, { permissions: {} });

        const subsequent = await roleAccess.forUser(role.name, {}, usersDb);
        expect(roleAccess.can(subsequent).readAny('users').granted).to.equal(false);
        expect(roleAccess.can(admitted).readAny('users').granted).to.equal(true);

        const unavailableUsers = {
            collection() {
                return {
                    async findOne() {
                        throw new Error('unavailable');
                    }
                };
            }
        };
        await assert.rejects(roleAccess.forUser(role.name, {}, unavailableUsers), /unavailable/);
    });

    it('retries cleanup safely and clears late assignments without removing restrictions or concurrent reassignments', async function () {
        const role = await handler.create({ name: uniqueName('cleanup'), permissions: {} });
        const user = new ObjectId();
        const restrictions = { labels: { create: false } };
        await usersDb.collection('users').insertOne({ _id: user, role: role.name, permissions: restrictions });

        await assert.rejects(roleDelete.run({}, { role: role.name }, {}, usersDb), /not committed/);
        await handler.delete(role.name);

        const fallback = await roleAccess.forUser('user', { role: role.name, permissions: restrictions }, usersDb);
        expect(roleAccess.can(fallback).readOwn('users').granted).to.equal(true);
        expect(roleAccess.can(fallback).createOwn('labels').granted).to.equal(false);

        const unavailableUsers = {
            collection(name) {
                if (name === 'users') {
                    return {
                        async updateMany() {
                            throw new Error('temporary write failure');
                        }
                    };
                }
                return usersDb.collection(name);
            }
        };

        await assert.rejects(roleDelete.run({}, { role: role.name }, {}, unavailableUsers), /temporary write failure/);

        expect((await roleDelete.run({}, { role: role.name }, {}, usersDb)).updated).to.equal(1);
        expect((await roleDelete.run({}, { role: role.name }, {}, usersDb)).updated).to.equal(0);
        const cleaned = await usersDb.collection('users').findOne({ _id: user });
        expect(cleaned).not.to.have.property('role');
        expect(cleaned.permissions).to.deep.equal(restrictions);

        // An assignment admitted just before deletion is checked again after its user write.
        await usersDb.collection('users').updateOne({ _id: user }, { $set: { role: role.name } });
        await handler.recheckAssignment(user, role.name);
        expect(await usersDb.collection('users').findOne({ _id: user })).not.to.have.property('role');
        await expectCode(handler.create({ name: role.name, permissions: {} }), 'RoleExists');

        const replacement = await handler.create({ name: uniqueName('replacement'), permissions: {} });
        await usersDb.collection('users').updateOne({ _id: user }, { $set: { role: replacement.name } });
        await handler.recheckAssignment(user, role.name);
        expect((await usersDb.collection('users').findOne({ _id: user })).role).to.equal(replacement.name);
    });

    it('rejects a custom role that conflicts with a source role name', async function () {
        await expectCode(handler.create({ name: 'root', description: 'conflict', permissions: {} }), 'RoleExists');
        const userId = 'user';
        const userRole = await roles.findOne({ _id: userId });
        await roles.deleteOne({ _id: userId });
        const conflicting = { _id: 'user', name: 'user', isSystem: false, deleted: false };
        await roles.insertOne(conflicting);
        await expectCode(handler.initialize(), 'RoleIdentityConflict');
        await roles.deleteOne({ _id: conflicting._id });
        await roles.insertOne(userRole);
        await handler.initialize();
    });

    it('accepts unlisted resources and validates grant operations, scopes, and attributes', async function () {
        expect(() => RoleHandler.validateGrants({ unlistedResource: { 'read:any': ['*'] } })).not.to.throw();
        expect(() => RoleHandler.validateRestrictions({ unlistedResource: { create: false } })).not.to.throw();
        const invalid = [
            { users: { 'run:any': ['*'] } },
            { users: { 'read:other': ['*'] } },
            { users: { 'read:any': [1] } },
            { users: { 'read:any': ['*', 1] } }
        ];
        for (const permissions of invalid) {
            await expectCode(handler.create({ name: uniqueName('invalid'), description: '', permissions }), 'InputValidationError');
        }
    });

    it('retains tombstones, permits explicit tombstone resolution, and rejects deleted assignments', async function () {
        const role = await handler.create({
            name: uniqueName('deleted'),
            description: '',
            permissions: {
                users: { 'read:any': ['id'] }
            }
        });

        expect(await handler.delete(role.name)).to.equal(true);
        expect(await db.database.collection(`${collectionName}_tasks`).findOne({ task: 'role-delete', 'data.role': role.name })).to.exist;
        const tombstone = await handler.resolve(role.name, { allowDeleted: true });
        expect(tombstone).to.include({ _id: role.name, name: role.name, deleted: true });

        await expectCode(handler.resolve(role.name), 'UnknownRole');
        await expectCode(handler.validateAssignment(role.name), 'InputValidationError');
        expect(await handler.validateAssignment('root')).to.equal('root');
        await expectCode(handler.validateAssignment(new ObjectId()), 'InputValidationError');
        await expectCode(handler.validateAssignment(''), 'InputValidationError');
        await expectCode(handler.create({ name: role.name, permissions: {} }), 'RoleExists');
    });
});

async function expectCode(promise, code) {
    try {
        await promise;
    } catch (err) {
        expect(err.code).to.equal(code);
        return;
    }
    expect.fail(`Expected rejection with code ${code}`);
}
