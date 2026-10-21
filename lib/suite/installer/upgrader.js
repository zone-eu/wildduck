'use strict';

const fs = require('fs');
const Path = require('path');
const packageData = require('../../../package.json');

function listMigrations() {
    let migrationsRoot = Path.join(__dirname, '..', '..', '..', 'migrations');
    let items = [];
    for (let subdir of ['database', 'users']) {
        let dirPath = Path.join(migrationsRoot, subdir);
        if (fs.existsSync(dirPath)) {
            let files = fs.readdirSync(dirPath).filter(f => f.endsWith('.js'));
            for (let file of files) {
                items.push(`${subdir}/${file}`);
            }
        }
    }
    return items;
}

function getUpgradeStatus(installerState) {
    let state = installerState ? installerState.load() : { version: packageData.version, snapshots: [] };
    let engineVersion = packageData.version || '1.55.1';
    let stateVersion = state.version || engineVersion;

    return {
        currentVersion: stateVersion,
        engineVersion,
        upgradeAvailable: stateVersion !== engineVersion,
        zeroTouchCoreIntact: true,
        migrations: listMigrations(),
        snapshots: state.snapshots || []
    };
}

async function runSafeUpgrade(options = {}) {
    let { installerState, targetVersion, migrationRunner } = options;
    if (!installerState) {
        throw new Error('installerState is required for runSafeUpgrade');
    }

    let currentState = installerState.load();
    let nextVersion = targetVersion || packageData.version || '1.55.1';
    let snapshot = installerState.createSnapshot(currentState.version, currentState.config);

    try {
        if (typeof migrationRunner === 'function') {
            await migrationRunner({
                fromVersion: currentState.version,
                toVersion: nextVersion
            });
        }

        let updated = installerState.load();
        updated.version = nextVersion;
        installerState.save(updated);

        return {
            success: true,
            rolledBack: false,
            previousVersion: currentState.version,
            currentVersion: nextVersion,
            snapshotId: snapshot.id
        };
    } catch (err) {
        installerState.restoreLatestSnapshot();
        return {
            success: false,
            rolledBack: true,
            error: err.message || String(err),
            restoredSnapshotId: snapshot.id
        };
    }
}

module.exports = {
    listMigrations,
    getUpgradeStatus,
    runSafeUpgrade
};
