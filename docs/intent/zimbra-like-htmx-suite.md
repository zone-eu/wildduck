# Statement of Intent: WildDuck HTMX Mail Suite & Smart Installer

## Overview

- **Outcome:** Package WildDuck (`v1.55.1` baseline) into an all-in-one, Zimbra-like open-source mail server suite featuring a multi-language Smart Installer (CLI + Web Setup Wizard) and an integrated, ultra-smooth HTMX Webmail and Admin Console.
- **User:** System administrators and self-hosters who want a one-command, zero-config mail server deployment without editing configuration files; end users who need a fast, modern Webmail client; and open-source contributors who want an approachable codebase for UI and localization contributions.
- **Why now:** WildDuck currently provides only core mail protocols (IMAP, POP3, LMTP), a REST API, and fragmented shell scripts under `setup/`, while traditional suites like Zimbra are resource-heavy and difficult for contributors to extend.
- **Success:** A user runs a single install command, selects their language, passes automated pre-flight checks (OS, hardware, ports), completes zero-config background service provisioning (MongoDB, Redis, Haraka, ZoneMTA, WildDuck) with live DNS/DKIM/SSL verification and idempotent resume on failure, and immediately accesses a complete HTMX Admin Console and Webmail interface.
- **Constraint:** Built with server-rendered HTML + HTMX mounted on a Zero-Touch Core architecture (zero modifications to upstream WildDuck `v1.55.1` core files so future WildDuck releases can be merged or upgraded without code conflicts), with full internationalization (i18n) from the installer onward.
- **Out of scope (v1):** Non-email groupware features outside WildDuck's existing core handlers (such as Calendar/CalDAV, Contacts/CardDAV, Chat, Drive/Briefcase) and a complex third-party plugin marketplace (Zimlets) in the first release.

## Architectural Principles

1. **Zero-Touch Upstream Core:** All new suite code (installer, Web Setup Wizard, Admin Console, Webmail, and language packs) lives in an isolated directory (`suite/`) and integrates with WildDuck via its exported Fastify app factory (`api.createApp`) and documented REST API contracts.
2. **Safe Version Upgrades:** Because upstream WildDuck files remain untouched, upgrading from WildDuck `1.55.1` to future versions requires zero merge conflicts for developers and supports automated pre-flight checks, database migrations, graceful worker reloads, and rollback for administrators.
3. **English-First Codebase with Built-in i18n:** All source code, technical documentation, and default fallback strings are written in English for global open-source collaboration, while every user-facing screen in the installer, Admin Console, and Webmail loads translations dynamically from flat JSON locale files (`suite/locales/*.json`).
