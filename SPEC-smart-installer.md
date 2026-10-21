# Spec: Smart Installer (`smart-installer`)

## Objective

Replace the legacy, non-interactive installation workflow with an intelligent, multi-language installer consisting of a CLI bootstrap script (`setup/install-suite.sh`) and an interactive HTMX Web Setup Wizard (`/setup`).
It enables administrators to deploy a complete, production-ready WildDuck mail server stack (WildDuck, MongoDB, Redis, Haraka, ZoneMTA, Nginx/TLS) or safely upgrade an existing `v1.55.1` deployment without manually editing TOML/INI configuration files.

## Tech Stack

- **CLI Bootstrap:** POSIX/Bash (`setup/install-suite.sh`) supporting interactive language selection (`en`, `vi`, ...) and launching the Web Setup Wizard.
- **Web Setup Wizard Backend:** Fastify routes under `lib/suite/installer/` using Node.js built-in `os`, `net`, `dns.promises`, `fs.promises`, and `child_process`.
- **DNS & Crypto Verification:** Node.js `dns.promises` (`resolveMx`, `resolveTxt`, `resolve4`, `reverse`), existing `lib/dkim-handler.js` / `lib/cert-handler.js` via WildDuck API, and `mailauth` (`7.3.0`).
- **State Persistence:** JSON state file (`/etc/wildduck/suite-install-state.json` or configurable path in `config/suite.toml`) tracking step completion for idempotent resume and upgrade rollback.

## Commands

```bash
# Run CLI Smart Installer in interactive mode
sudo ./setup/install-suite.sh

# Lint Smart Installer JavaScript modules
NODE_ENV=test ./node_modules/.bin/eslint lib/suite/installer/**/*.js test/suite/smart-installer-test.js

# Run Smart Installer unit and integration tests (pre-flight, DNS verifier, state machine, upgrade runner)
NODE_ENV=test ./node_modules/.bin/mocha --exit test/suite/smart-installer-test.js
```

## Project Structure

```text
setup/install-suite.sh                    -> Multi-language CLI bootstrap that checks root/OS, starts WildDuck Suite in setup mode, and prints the Web Wizard URL + one-time setup token
lib/suite/installer/state.js              -> Idempotent step state machine (pending, running, completed, failed) with resume and backup snapshot helpers
lib/suite/installer/preflight.js          -> Hardware (RAM, CPU, disk free), OS detection, public IP discovery, and port availability checks (25, 80, 443, 143, 993, 465, 587)
lib/suite/installer/provisioner.js        -> Zero-config generator for TOML configurations, random secret generation, database index initialization, and service orchestration
lib/suite/installer/dns-verifier.js       -> Live DNS record generator and checker for MX, A/AAAA, SPF, DKIM, DMARC, and PTR (reverse DNS)
lib/suite/installer/upgrader.js           -> Safe version upgrade runner (checks current version 1.55.1, backs up config, runs migrations, reloads workers via SIGHUP, rolls back on failure)
lib/suite/installer/routes.js             -> Fastify HTMX routes for the 6-step Web Setup Wizard (/setup/*)
lib/suite/installer/views.js              -> HTMX templates for language selection, pre-flight report, domain/admin setup, live service provisioning progress, and DNS verification table
test/suite/smart-installer-test.js        -> Mocha tests for pre-flight diagnostics, DNS verification, config generation, idempotent resume, and upgrade rollback
```

## Code Style

```javascript
'use strict';

const dns = require('dns').promises;

async function verifyDomainDns({ mailDomain, hostname, dkimSelector, dkimPublicKey }) {
    let checks = {
        mx: { status: 'fail', expected: hostname, actual: [] },
        spf: { status: 'fail', expected: `v=spf1 mx a:${hostname} -all`, actual: [] },
        dkim: { status: 'fail', expected: `v=DKIM1; k=rsa; p=${dkimPublicKey}`, actual: [] },
        dmarc: { status: 'fail', expected: 'v=DMARC1; p=quarantine;', actual: [] }
    };

    try {
        let mxRecords = await dns.resolveMx(mailDomain);
        checks.mx.actual = mxRecords.map(r => r.exchange.replace(/\.$/, ''));
        if (checks.mx.actual.includes(hostname)) {
            checks.mx.status = 'pass';
        }
    } catch (err) {
        checks.mx.error = err.code || err.message;
    }

    return checks;
}

module.exports = {
    verifyDomainDns
};
```

## Testing Strategy

- **Framework:** Mocha (`12.0.3`) and Chai (`4.3.10`) with injectable mocks for system probes (`os`, `net`, `dns.promises`, service runners) so tests run deterministically in CI and local development without modifying host `/etc` files.
- **Location:** `test/suite/smart-installer-test.js`.
- **Coverage Areas:**
  - Pre-flight check detects insufficient RAM/disk and occupied ports accurately.
  - Zero-config provisioner generates valid TOML files with cryptographic secrets and never overwrites existing secrets on resume.
  - DNS verifier accurately reports `pass`/`warn`/`fail` badges for MX, SPF, DKIM, DMARC, and PTR records.
  - Idempotent state machine resumes from the exact failed step when re-triggered.
  - Setup Wizard locks itself out (`403 Forbidden`) once installation state is marked `completed` unless unlocked by an authenticated administrator for upgrades.

## Boundaries

- **Always:**
  - Require a one-time setup token (generated by CLI or config) to access `/setup` before an admin account exists.
  - Lock `/setup` automatically as soon as initial setup completes.
  - Create a configuration backup snapshot before applying changes or running an upgrade.
- **Ask first:**
  - Changing firewall rules (`ufw`) or stopping existing system services outside the provisioning step.
- **Never:**
  - Log generated passwords, access tokens, or DKIM private keys to stdout or log files.
  - Delete existing `/var/opt` or `/etc/wildduck` data during a resumed installation or version upgrade.

## Success Criteria

- Step 1 of `/setup` allows choosing the installation language (`en`, `vi`) and immediately re-renders the wizard in that language.
- Step 2 runs automated Pre-flight checks (CPU, RAM, disk, ports 25/80/443/143/993/465/587) and renders clear pass/warn/fail indicators with actionable remediation tips.
- Step 3 collects primary mail domain, server hostname, and initial admin credentials, automatically provisions config/keys/DKIM, and supports retrying any failed sub-step without starting over.
- Step 4 displays exact copy-pasteable DNS records (MX, A, SPF, DKIM, DMARC, PTR) and provides a live HTMX "Verify DNS" button that queries DNS and updates status badges in place.
- Step 5 finalizes setup, locks the setup wizard, and redirects straight into the HTMX Admin Console / Webmail.

## Open Questions

- None for `smart-installer`.
