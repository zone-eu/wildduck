'use strict';

const { expect } = require('chai');
const EventEmitter = require('events');
const ImapNotifier = require('../lib/imap-notifier');
const metrics = require('../lib/metrics');

describe('ImapNotifier metrics', () => {
    let originalSetNotificationListenerCounts;

    beforeEach(() => {
        originalSetNotificationListenerCounts = metrics.setNotificationListenerCounts;
    });

    afterEach(() => {
        metrics.setNotificationListenerCounts = originalSetNotificationListenerCounts;
    });

    const createNotifier = () => {
        let registered = [];
        let unregistered = [];
        let notifier = Object.create(ImapNotifier.prototype);
        notifier._userRegistryState = { counts: new Map() };
        notifier._listeners = new EventEmitter();
        notifier.logger = { debug() {} };
        notifier._registerUserWorker = userId => registered.push(userId);
        notifier._unregisterUserWorker = userId => unregistered.push(userId);
        return { notifier, registered, unregistered };
    };

    it('should maintain process-wide listener counts across notifier instances', () => {
        let observations = [];
        metrics.setNotificationListenerCounts = (users, listeners) => observations.push({ users, listeners });

        let first = createNotifier();
        let second = createNotifier();

        first.notifier._incrementUserListener('user-a');
        second.notifier._incrementUserListener('user-a');
        first.notifier._incrementUserListener('user-b');

        expect(first.registered).to.deep.equal(['user-a', 'user-b']);
        expect(second.registered).to.deep.equal([]);
        expect(observations[observations.length - 1]).to.deep.equal({ users: 2, listeners: 3 });

        second.notifier._decrementUserListener('user-a');
        expect(second.unregistered).to.deep.equal([]);
        expect(observations[observations.length - 1]).to.deep.equal({ users: 2, listeners: 2 });

        first.notifier._decrementUserListener('user-a');
        first.notifier._decrementUserListener('user-b');
        expect(first.unregistered).to.deep.equal(['user-a', 'user-b']);
        expect(observations[observations.length - 1]).to.deep.equal({ users: 0, listeners: 0 });

        second.notifier._decrementUserListener('user-a');
        expect(second.unregistered).to.deep.equal([]);
        expect(observations[observations.length - 1]).to.deep.equal({ users: 0, listeners: 0 });
    });

    it('should not decrement counts when removing an unknown handler', () => {
        let observations = [];
        metrics.setNotificationListenerCounts = (users, listeners) => observations.push({ users, listeners });

        let entry = createNotifier();
        let session = {
            id: 'session',
            user: {
                id: { toString: () => 'user-c' },
                username: 'user-c'
            }
        };
        let registeredHandler = () => false;

        entry.notifier.addListener(session, registeredHandler);
        entry.notifier.removeListener(session, () => false);
        expect(entry.unregistered).to.deep.equal([]);
        expect(observations[observations.length - 1]).to.deep.equal({ users: 1, listeners: 1 });

        entry.notifier.removeListener(session, registeredHandler);
        expect(entry.unregistered).to.deep.equal(['user-c']);
        expect(observations[observations.length - 1]).to.deep.equal({ users: 0, listeners: 0 });
    });
});
