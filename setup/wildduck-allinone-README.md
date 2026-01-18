# WildDuck All-in-One Docker Image

Run a complete mail stack (WildDuck, Haraka, ZoneMTA, Webmail, Nginx, MongoDB, Redis, Rspamd, ClamAV) in a single container.

Container image:
`ghcr.io/zone-eu/wildduck-allinone:latest`

## 5‑Minute Setup

### 1) Get the image

Pull from GHCR:

```
docker pull ghcr.io/zone-eu/wildduck-allinone:latest
```

Or build locally:

```
docker build --no-cache -f setup/Dockerfile -t wildduck-allinone .
```

### 2) Start the container

Self-signed TLS (fastest to get running):

```
docker run \
  -e MAILDOMAIN=example.com \
  -e WILDDUCK_HOSTNAME=mail.example.com \
  -v wildduck-data:/data \
  -p 25:25 -p 465:465 -p 993:993 -p 995:995 -p 80:80 -p 443:443 \
  ghcr.io/zone-eu/wildduck-allinone:latest
```

### 3) Open the webmail

```
https://mail.example.com/
```

## Optional: Real TLS via ACME (Let's Encrypt)

```
docker run \
  -e MAILDOMAIN=example.com \
  -e WILDDUCK_HOSTNAME=mail.example.com \
  -e ACME_ENABLED=1 \
  -e ACME_EMAIL=admin@example.com \
  -v wildduck-data:/data \
  -p 80:80 -p 443:443 -p 25:25 -p 465:465 -p 993:993 -p 995:995 \
  ghcr.io/zone-eu/wildduck-allinone:latest
```

Notes:
- ACME uses `--standalone` on startup and needs port 80 free.
- Automatic renewals run in the container and update certs in `/etc/wildduck/certs`.

## Optional: Expose the API on host loopback

```
docker run \
  -e MAILDOMAIN=example.com \
  -e WILDDUCK_HOSTNAME=mail.example.com \
  -e EXPOSE_API=1 \
  -v wildduck-data:/data \
  -p 127.0.0.1:8080:8080 \
  -p 25:25 -p 465:465 -p 993:993 -p 995:995 -p 80:80 -p 443:443 \
  ghcr.io/zone-eu/wildduck-allinone:latest
```

## Environment variables

- `MAILDOMAIN` (required): Email domain (the part after `@`).
- `WILDDUCK_HOSTNAME` (required): Mail server hostname (MX/HTTPS host).
- `EXPOSE_API` (optional): `1` to bind WildDuck API to `0.0.0.0`, otherwise `127.0.0.1`.
- `DISABLE_CLAMAV` (optional): `1` disables ClamAV (default `1`).
- `DISABLE_RSPAMD` (optional): `1` disables Rspamd (default `0`).
- `ACME_ENABLED` (optional): `1` to enable ACME. Default `0`.
- `ACME_EMAIL` (required if ACME enabled): Email for ACME account.
- `ACME_SERVER` (optional): ACME directory, default `letsencrypt`.
- `PUBLIC_IP` (optional): Public IP used in DNS output. Auto-detected if unset.
- `DATA_DIR` (optional): Base directory for persistent data, default `/data`.
- `SRS_SECRET`, `DKIM_SECRET`, `ZONEMTA_SECRET`, `DKIM_SELECTOR` (optional): override auto-generated secrets.

## Ports

- 25 SMTP
- 465 SMTP TLS (implicit TLS, STARTTLS disabled)
- 993 IMAP TLS
- 995 POP3 TLS
- 80 HTTP
- 443 HTTPS
- 8080 WildDuck API (only if `EXPOSE_API=1` and you publish it)

## Data volume layout

Mount a single volume at `/data`. The entrypoint wires service paths to this directory using symlinks.

| Service / Purpose | Container path | Location under `/data` |
| --- | --- | --- |
| WildDuck config | `/etc/wildduck` | `/data/wildduck/etc` |
| WildDuck TLS certs | `/etc/wildduck/certs` | `/data/wildduck/certs` |
| ZoneMTA config | `/etc/zone-mta` | `/data/zone-mta/etc` |
| ZoneMTA keys | `/opt/zone-mta/keys` | `/data/zone-mta/keys` |
| Haraka config | `/opt/haraka/config` | `/data/haraka/config` |
| Haraka queue | `/opt/haraka/queue` | `/data/haraka/queue` |
| MongoDB data | `/var/lib/mongodb` | `/data/mongodb` |
| Redis data | `/var/lib/redis` | `/data/redis` |
| Rspamd data | `/var/lib/rspamd` | `/data/rspamd` |
| ClamAV DB | `/var/lib/clamav` | `/data/clamav` |
| ACME state | `/var/lib/acme` | `/data/acme` |

## Access

- Webmail UI: `https://<WILDDUCK_HOSTNAME>/`
- API (if exposed): `http://127.0.0.1:8080/`

## Notes

- This container replaces systemd with supervisord.
- Logs are routed to stdout/stderr for `docker logs`.
