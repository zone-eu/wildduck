'use strict';

const fs = require('fs');
const Path = require('path');
const config = require('@zone-eu/wild-config');

const STEP_ORDER = ['language', 'preflight', 'provision', 'dns', 'finalize'];

function defaultState() {
    return {
        version: '1.55.1',
        locale: (config.suite && config.suite.defaultLocale) || 'en',
        locked: false,
        currentStep: 1,
        resumeStep: 1,
        config: {
            mailDomain: '',
            hostname: '',
            publicIp: '127.0.0.1',
            adminUsername: 'admin',
            dkimSelector: 'wd2026',
            dkimPublicKey: '',
            enableLetsEncrypt: true
        },
        steps: {
            language: { status: 'pending', updatedAt: null, error: null },
            preflight: { status: 'pending', updatedAt: null, error: null },
            provision: { status: 'pending', updatedAt: null, error: null },
            dns: { status: 'pending', updatedAt: null, error: null },
            finalize: { status: 'pending', updatedAt: null, error: null }
        },
        snapshots: [],
        updatedAt: new Date().toISOString()
    };
}

function computeResumeStep(steps) {
    for (let i = 0; i < STEP_ORDER.length; i++) {
        let name = STEP_ORDER[i];
        let entry = steps && steps[name];
        if (!entry || entry.status !== 'completed') {
            return i + 1;
        }
    }
    return STEP_ORDER.length;
}

function createInstallerState(options = {}) {
    let stateFile =
        options.stateFile ||
        (config.suite && config.suite.stateFile) ||
        Path.join('/tmp', 'wildduck-suite-install-state.json');

    function load() {
        try {
            if (fs.existsSync(stateFile)) {
                let raw = fs.readFileSync(stateFile, 'utf8');
                let parsed = JSON.parse(raw);
                let base = defaultState();
                let merged = {
                    ...base,
                    ...parsed,
                    config: { ...base.config, ...(parsed.config || {}) },
                    steps: { ...base.steps, ...(parsed.steps || {}) },
                    snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : []
                };
                merged.resumeStep = computeResumeStep(merged.steps);
                return merged;
            }
        } catch (err) {
            // Fall back to fresh default state if corrupted
        }
        return defaultState();
    }

    function save(state) {
        let dir = Path.dirname(stateFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        state.updatedAt = new Date().toISOString();
        state.resumeStep = computeResumeStep(state.steps);
        let tmpPath = `${stateFile}.tmp-${process.pid}`;
        fs.writeFileSync(tmpPath, JSON.stringify(state, null, 4), 'utf8');
        fs.renameSync(tmpPath, stateFile);
        return state;
    }

    function updateStep(stepName, status, extra = {}) {
        let state = load();
        if (!state.steps[stepName]) {
            state.steps[stepName] = { status: 'pending', updatedAt: null, error: null };
        }
        state.steps[stepName] = {
            status,
            updatedAt: new Date().toISOString(),
            error: extra.error || null
        };
        if (extra.locale) {
            state.locale = extra.locale;
        }
        if (extra.config) {
            state.config = { ...state.config, ...extra.config };
        }
        state.currentStep = computeResumeStep(state.steps);
        return save(state);
    }

    function saveConfig(partialConfig) {
        let state = load();
        state.config = { ...state.config, ...(partialConfig || {}) };
        return save(state);
    }

    function createSnapshot(versionLabel, configSnapshot) {
        let state = load();
        let snap = {
            id: `snap-${Date.now()}`,
            version: versionLabel || state.version,
            createdAt: new Date().toISOString(),
            config: JSON.parse(JSON.stringify(configSnapshot || state.config))
        };
        state.snapshots.push(snap);
        if (state.snapshots.length > 10) {
            state.snapshots = state.snapshots.slice(-10);
        }
        save(state);
        return snap;
    }

    function restoreLatestSnapshot() {
        let state = load();
        if (!state.snapshots.length) {
            return state;
        }
        let latest = state.snapshots[state.snapshots.length - 1];
        state.config = JSON.parse(JSON.stringify(latest.config));
        state.version = latest.version || state.version;
        return save(state);
    }

    function lock() {
        let state = load();
        state.locked = true;
        state.steps.finalize = {
            status: 'completed',
            updatedAt: new Date().toISOString(),
            error: null
        };
        return save(state);
    }

    function unlock() {
        let state = load();
        state.locked = false;
        return save(state);
    }

    return {
        stateFile,
        load,
        save,
        updateStep,
        saveConfig,
        createSnapshot,
        restoreLatestSnapshot,
        lock,
        unlock
    };
}

module.exports = {
    STEP_ORDER,
    createInstallerState
};
