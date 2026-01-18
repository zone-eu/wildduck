FROM ubuntu:22.04 AS builder

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG NODE_MAJOR=22
ARG HARAKA_VERSION=3.0.5

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        lsb-release \
        git \
        build-essential \
        python3 \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    ARCHITECTURE="$(dpkg --print-architecture)"; \
    install -d -m 0755 /usr/share/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg; \
    echo "deb [arch=${ARCHITECTURE} signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    mkdir -p /var/opt /opt; \
    git clone --bare https://github.com/zone-eu/wildduck.git /var/opt/wildduck.git; \
    git clone --bare https://github.com/zone-eu/haraka-plugin-wildduck.git /var/opt/haraka-plugin-wildduck.git; \
    git clone --bare https://github.com/zone-eu/zone-mta-template.git /var/opt/zone-mta.git; \
    git clone --bare https://github.com/zone-eu/zonemta-wildduck.git /var/opt/zonemta-wildduck.git; \
    git clone --bare https://github.com/nodemailer/wildduck-webmail.git /var/opt/wildduck-webmail.git; \
    latest_commit() { \
        local repo="$1"; \
        git --git-dir="$repo" fetch --tags; \
        local tag; \
        tag="$(git --git-dir="$repo" describe --tags "$(git --git-dir="$repo" rev-list --tags --max-count=1)")"; \
        git --git-dir="$repo" rev-list -n 1 "$tag"; \
    }; \
    mkdir -p /opt/wildduck; \
    git --git-dir=/var/opt/wildduck.git --work-tree=/opt/wildduck checkout "$(latest_commit /var/opt/wildduck.git)"; \
    mkdir -p /opt/zone-mta; \
    git --git-dir=/var/opt/zone-mta.git --work-tree=/opt/zone-mta checkout "$(latest_commit /var/opt/zone-mta.git)"; \
    mkdir -p /opt/zone-mta/plugins/wildduck; \
    git --git-dir=/var/opt/zonemta-wildduck.git --work-tree=/opt/zone-mta/plugins/wildduck checkout "$(latest_commit /var/opt/zonemta-wildduck.git)"; \
    mkdir -p /opt/wildduck-webmail; \
    git --git-dir=/var/opt/wildduck-webmail.git --work-tree=/opt/wildduck-webmail checkout "$(latest_commit /var/opt/wildduck-webmail.git)"; \
    npm install -g Haraka@"${HARAKA_VERSION}"; \
    haraka -i /opt/haraka; \
    cd /opt/wildduck; \
    npm install --omit=dev --omit=optional --no-package-lock --no-audit --ignore-scripts --no-shrinkwrap; \
    cd /opt/haraka; \
    npm install --omit=dev --omit=optional --no-package-lock --no-audit --no-shrinkwrap --save haraka-plugin-rspamd haraka-plugin-redis Haraka@"${HARAKA_VERSION}"; \
    mkdir -p /opt/haraka/plugins/wildduck; \
    git --git-dir=/var/opt/haraka-plugin-wildduck.git --work-tree=/opt/haraka/plugins/wildduck checkout "$(latest_commit /var/opt/haraka-plugin-wildduck.git)"; \
    cd /opt/haraka/plugins/wildduck; \
    npm install --omit=dev --omit=optional --no-package-lock --no-audit --ignore-scripts --no-shrinkwrap --progress=false; \
    cd /opt/zone-mta; \
    npm install --omit=dev --omit=optional --no-package-lock --no-audit --ignore-scripts --no-shrinkwrap; \
    cd /opt/zone-mta/plugins/wildduck; \
    npm install --omit=dev --omit=optional --no-package-lock --no-audit --ignore-scripts --no-shrinkwrap --progress=false; \
    cd /opt/wildduck-webmail; \
    npm install --progress=false; \
    npm run bowerdeps; \
    npm cache clean --force; \
    rm -rf /root/.npm /var/lib/apt/lists/*

FROM ubuntu:22.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG NODE_MAJOR=22
ARG MONGODB_VERSION=8.0
ARG HARAKA_VERSION=3.0.5
ARG ACME_VERSION=3.0.6

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        lsb-release \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    CODENAME="$(lsb_release -c -s)"; \
    ARCHITECTURE="$(dpkg --print-architecture)"; \
    install -d -m 0755 /usr/share/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg; \
    echo "deb [arch=${ARCHITECTURE} signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list; \
    curl -fsSL https://pgp.mongodb.com/server-${MONGODB_VERSION}.asc \
        | gpg --dearmor -o /usr/share/keyrings/mongodb-server-${MONGODB_VERSION}.gpg; \
    echo "deb [arch=${ARCHITECTURE} signed-by=/usr/share/keyrings/mongodb-server-${MONGODB_VERSION}.gpg] https://repo.mongodb.org/apt/ubuntu ${CODENAME}/mongodb-org/${MONGODB_VERSION} multiverse" \
        > /etc/apt/sources.list.d/mongodb-org.list; \
    curl -fsSL https://rspamd.com/apt-stable/gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/rspamd.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/rspamd.gpg] http://rspamd.com/apt-stable/ ${CODENAME} main" \
        > /etc/apt/sources.list.d/rspamd.list; \
    curl -fsSL https://packages.redis.io/gpg \
        | gpg --dearmor -o /usr/share/keyrings/redis.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/redis.gpg] https://packages.redis.io/deb ${CODENAME} main" \
        > /etc/apt/sources.list.d/redis.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        clamav \
        clamav-daemon \
        mongodb-org \
        nginx \
        nodejs \
        openssl \
        pwgen \
        redis-server \
        rspamd \
        socat \
        supervisor \
        tini \
    ; \
    apt-get purge -y gnupg lsb-release; \
    apt-get autoremove -y; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

RUN useradd -r -U wildduck \
    && useradd -r -U deploy \
    && mkdir -p /home/deploy/.ssh \
    && chown -R deploy:deploy /home/deploy

RUN curl -fsSL "https://raw.githubusercontent.com/acmesh-official/acme.sh/${ACME_VERSION}/acme.sh" \
    -o /usr/local/bin/acme.sh \
    && chmod +x /usr/local/bin/acme.sh

COPY --from=builder /opt /opt

RUN cat > /usr/local/bin/register-dkim <<'EOF'
#!/bin/bash
set -euo pipefail

if [ -z "${MAILDOMAIN:-}" ]; then
  exit 0
fi

if [ ! -f /etc/wildduck/dkim.json ]; then
  exit 0
fi

printf "Waiting for WildDuck API..."
until curl -fsS http://127.0.0.1:8080/users >/dev/null; do
  printf '.'
  sleep 2
done
echo ""

curl -sS -XPOST http://127.0.0.1:8080/dkim \
  -H 'Content-type: application/json' \
  -d @/etc/wildduck/dkim.json || true
EOF
RUN chmod +x /usr/local/bin/register-dkim

RUN cat > /usr/local/bin/acme-renew <<'EOF'
#!/bin/bash
set -euo pipefail

if [ "${ACME_ENABLED:-0}" != "1" ]; then
  exit 0
fi

ACME_SERVER="${ACME_SERVER:-letsencrypt}"

while true; do
  /usr/local/bin/acme.sh --cron \
    --home /var/lib/acme \
    --config-home /var/lib/acme \
    --server "$ACME_SERVER" \
    --pre-hook "supervisorctl stop nginx || true" \
    --post-hook "supervisorctl start nginx || true" || true
  sleep 12h
done
EOF
RUN chmod +x /usr/local/bin/acme-renew

RUN cat > /usr/local/bin/wildduck-entrypoint <<'EOF'
#!/bin/bash
set -euo pipefail

MAILDOMAIN="${MAILDOMAIN:-}"
WILDDUCK_HOSTNAME="${WILDDUCK_HOSTNAME:-${MAILDOMAIN}}"
EXPOSE_API="${EXPOSE_API:-0}"
WILDDUCK_API_EXPOSE="${WILDDUCK_API_EXPOSE:-$EXPOSE_API}"
DATA_DIR="${DATA_DIR:-/data}"
PUBLIC_IP="${PUBLIC_IP:-}"
DISABLE_CLAMAV="${DISABLE_CLAMAV:-1}"
DISABLE_RSPAMD="${DISABLE_RSPAMD:-0}"
ACME_ENABLED="${ACME_ENABLED:-0}"
ACME_EMAIL="${ACME_EMAIL:-}"
ACME_SERVER="${ACME_SERVER:-letsencrypt}"
export WILDDUCK_API_EXPOSE DATA_DIR PUBLIC_IP DISABLE_CLAMAV DISABLE_RSPAMD ACME_ENABLED ACME_EMAIL ACME_SERVER

if [ -z "$MAILDOMAIN" ]; then
  echo "MAILDOMAIN is required (eg. example.com)."
  exit 1
fi

if [ -z "$WILDDUCK_HOSTNAME" ]; then
  echo "WILDDUCK_HOSTNAME is required (eg. mail.example.com)."
  exit 1
fi

if [ "$ACME_ENABLED" = "1" ] && [ -z "$ACME_EMAIL" ]; then
  echo "ACME_EMAIL is required when ACME_ENABLED=1."
  exit 1
fi

SRS_SECRET="${SRS_SECRET:-$(pwgen 12 -1)}"
DKIM_SECRET="${DKIM_SECRET:-$(pwgen 12 -1)}"
ZONEMTA_SECRET="${ZONEMTA_SECRET:-$(pwgen 12 -1)}"
DKIM_SELECTOR="${DKIM_SELECTOR:-$(node -e 'console.log(Date().toString().substr(4, 3).toLowerCase() + new Date().getFullYear())')}"

export MAILDOMAIN WILDDUCK_HOSTNAME SRS_SECRET DKIM_SECRET ZONEMTA_SECRET DKIM_SELECTOR

ensure_link() {
  local target="$1"
  local link="$2"

  if [ -L "$link" ]; then
    return
  fi

  mkdir -p "$target"
  if [ -e "$link" ]; then
    cp -a "$link"/. "$target"/ 2>/dev/null || true
    rm -rf "$link"
  fi
  ln -s "$target" "$link"
}

set_toml_key() {
  local file="$1"
  local key="$2"
  local value="$3"

  if grep -q "^${key} *=" "$file"; then
    sed -i -e "s|^${key} *=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" >> "$file"
  fi
}

mkdir -p "$DATA_DIR"
ensure_link "$DATA_DIR/wildduck/etc" /etc/wildduck
ensure_link "$DATA_DIR/wildduck/certs" /etc/wildduck/certs
ensure_link "$DATA_DIR/zone-mta/etc" /etc/zone-mta
ensure_link "$DATA_DIR/zone-mta/keys" /opt/zone-mta/keys
ensure_link "$DATA_DIR/haraka/config" /opt/haraka/config
ensure_link "$DATA_DIR/haraka/queue" /opt/haraka/queue
ensure_link "$DATA_DIR/mongodb" /var/lib/mongodb
ensure_link "$DATA_DIR/redis" /var/lib/redis
ensure_link "$DATA_DIR/rspamd" /var/lib/rspamd
ensure_link "$DATA_DIR/clamav" /var/lib/clamav
ensure_link "$DATA_DIR/acme" /var/lib/acme

if [ ! -f /etc/wildduck/wildduck.toml ]; then
  cp -r /opt/wildduck/config/* /etc/wildduck/
  mv /etc/wildduck/default.toml /etc/wildduck/wildduck.toml
  sed -i -e 's/"disabled": true/"disabled": false/g' /opt/wildduck/emails/00-example.json
  sed -i -e "s/999/99/g;s/localhost/${WILDDUCK_HOSTNAME}/g" /etc/wildduck/imap.toml
  sed -i -e "s/999/99/g;s/localhost/${WILDDUCK_HOSTNAME}/g" /etc/wildduck/pop3.toml
  cat > /etc/wildduck/lmtp.toml <<EOT
enabled=true
port=24
disableSTARTTLS=true
EOT
  echo "secret=\"$DKIM_SECRET\"" >> /etc/wildduck/dkim.toml
  printf "user=\"wildduck\"\ngroup=\"wildduck\"\nemailDomain=\"%s\"\n" "$MAILDOMAIN" \
    | cat - /etc/wildduck/wildduck.toml > /etc/wildduck/wildduck.toml.tmp \
    && mv /etc/wildduck/wildduck.toml.tmp /etc/wildduck/wildduck.toml
  sed -i -e "s/localhost:3000/${WILDDUCK_HOSTNAME}/g;s/localhost/${WILDDUCK_HOSTNAME}/g;s/2587/465/g" /etc/wildduck/wildduck.toml
  sed -i -e "s/secret value/${SRS_SECRET}/g;s/#loopSecret/loopSecret/g" /etc/wildduck/sender.toml
fi

if [ -f /etc/wildduck/api.toml ]; then
  if [ "$WILDDUCK_API_EXPOSE" = "1" ]; then
    sed -i -e 's/^host = .*/host = "0.0.0.0"/' /etc/wildduck/api.toml
  else
    sed -i -e 's/^host = .*/host = "127.0.0.1"/' /etc/wildduck/api.toml
  fi
fi

if [ ! -f /etc/wildduck/tls.toml ]; then
  cat > /etc/wildduck/tls.toml <<EOT
cert="/etc/wildduck/certs/fullchain.pem"
key="/etc/wildduck/certs/privkey.pem"
EOT
fi

if [ ! -f /etc/wildduck/certs/privkey.pem ]; then
  openssl req -subj "/CN=${WILDDUCK_HOSTNAME}/O=WildDuck/C=US" -new -newkey rsa:4096 -days 365 -nodes -x509 \
    -keyout /etc/wildduck/certs/privkey.pem \
    -out /etc/wildduck/certs/fullchain.pem
  chown -R wildduck:wildduck /etc/wildduck/certs
  chmod 0640 /etc/wildduck/certs/privkey.pem
fi

if [ "$ACME_ENABLED" = "1" ]; then
  mkdir -p /var/lib/acme
  /usr/local/bin/acme.sh --register-account -m "$ACME_EMAIL" --server "$ACME_SERVER" \
    --home /var/lib/acme --config-home /var/lib/acme || true
  /usr/local/bin/acme.sh --issue --standalone -d "$WILDDUCK_HOSTNAME" \
    --server "$ACME_SERVER" \
    --home /var/lib/acme --config-home /var/lib/acme \
    --reloadcmd "/bin/true" || echo "Warning: ACME issuance failed, using existing certs"
  /usr/local/bin/acme.sh --install-cert -d "$WILDDUCK_HOSTNAME" \
    --home /var/lib/acme --config-home /var/lib/acme \
    --key-file /etc/wildduck/certs/privkey.pem \
    --fullchain-file /etc/wildduck/certs/fullchain.pem \
    --reloadcmd "/bin/true" || true
  chown -R wildduck:wildduck /etc/wildduck/certs
  chmod 0640 /etc/wildduck/certs/privkey.pem || true
fi

if [ ! -f /etc/zone-mta/zonemta.toml ]; then
  cp -r /opt/zone-mta/config/* /etc/zone-mta/
  sed -i -e 's/port=2525/port=465/g;s/host="127.0.0.1"/host="0.0.0.0"/g;s/authentication=false/authentication=true/g' /etc/zone-mta/interfaces/feeder.toml
  set_toml_key /etc/zone-mta/interfaces/feeder.toml secure true
  set_toml_key /etc/zone-mta/interfaces/feeder.toml starttls false
  set_toml_key /etc/zone-mta/interfaces/feeder.toml key "\"/etc/wildduck/certs/privkey.pem\""
  set_toml_key /etc/zone-mta/interfaces/feeder.toml cert "\"/etc/wildduck/certs/fullchain.pem\""
  rm -f /etc/zone-mta/plugins/dkim.toml
  echo '# @include "/etc/wildduck/dbs.toml"' > /etc/zone-mta/dbs-production.toml
  printf "user=\"wildduck\"\ngroup=\"wildduck\"\n" \
    | cat - /etc/zone-mta/zonemta.toml > /etc/zone-mta/zonemta.toml.tmp \
    && mv /etc/zone-mta/zonemta.toml.tmp /etc/zone-mta/zonemta.toml
  set_toml_key /etc/zone-mta/zonemta.toml corePluginsPath "\"/opt/zone-mta/node_modules/@zone-eu/zone-mta/plugins\""
  set_toml_key /etc/zone-mta/zonemta.toml pluginsPath "\"/opt/zone-mta\""
  cat > /etc/zone-mta/pools.toml <<EOT
[[default]]
address="0.0.0.0"
name="${WILDDUCK_HOSTNAME}"
EOT
  cat > /etc/zone-mta/plugins/loop-breaker.toml <<EOT
["modules/zonemta-loop-breaker"]
enabled="sender"
secret="${ZONEMTA_SECRET}"
algo="md5"
EOT
  cat > /etc/zone-mta/plugins/wildduck.toml <<EOT
[wildduck]
enabled=["receiver", "sender", "main"]
interfaces=["feeder"]
hostname="${WILDDUCK_HOSTNAME}"

[wildduck.srs]
enabled=true
secret="${SRS_SECRET}"
rewriteDomain="${MAILDOMAIN}"

[wildduck.dkim]
# @include "/etc/wildduck/dkim.toml"
EOT
fi

if [ ! -f /etc/wildduck/wildduck-webmail.toml ]; then
  cp /opt/wildduck-webmail/config/default.toml /etc/wildduck/wildduck-webmail.toml
  sed -i -e "s/localhost/${WILDDUCK_HOSTNAME}/g;s/999/99/g;s/2587/465/g;s/proxy=false/proxy=true/g;s/domains=.*/domains=[\"${MAILDOMAIN}\"]/g" \
    /etc/wildduck/wildduck-webmail.toml
  sed -i -e '/\[setup\.smtp\]/,/\[/{s/secure=false/secure=true/g; s/port=2587/port=465/g;}' \
    /etc/wildduck/wildduck-webmail.toml
fi

if [ ! -f /opt/haraka/config/wildduck.yaml ]; then
  mv /opt/haraka/config/plugins /opt/haraka/config/plugins.bak 2>/dev/null || true
  {
    if [ "$DISABLE_CLAMAV" != "1" ]; then
      echo "clamd"
    else
      echo "#clamd"
    fi
    if [ "$DISABLE_RSPAMD" != "1" ]; then
      echo "rspamd"
    else
      echo "#rspamd"
    fi
    echo "tls"
    echo "wildduck"
  } > /opt/haraka/config/plugins
  echo "26214400" > /opt/haraka/config/databytes
  echo "${WILDDUCK_HOSTNAME}" > /opt/haraka/config/me
  echo "WildDuck MX" > /opt/haraka/config/smtpgreeting
  cat > /opt/haraka/config/tls.ini <<EOT
key=/etc/wildduck/certs/privkey.pem
cert=/etc/wildduck/certs/fullchain.pem
EOT
  cat > /opt/haraka/config/rspamd.ini <<'EOT'
host = localhost
port = 11333
add_headers = always
[dkim]
enabled = true
[header]
bar = X-Rspamd-Bar
report = X-Rspamd-Report
score = X-Rspamd-Score
spam = X-Rspamd-Spam
[check]
authenticated=true
private_ip=true
[reject]
spam = false
[soft_reject]
enabled = true
[rmilter_headers]
enabled = true
[spambar]
positive = +
negative = -
neutral = /
EOT
  cat > /opt/haraka/config/clamd.ini <<'EOT'
clamd_socket = /var/run/clamav/clamd.ctl
[reject]
virus=true
error=false
EOT
  cp /opt/haraka/plugins/wildduck/config/wildduck.yaml /opt/haraka/config/wildduck.yaml
  sed -i -e "s/secret value/${SRS_SECRET}/g;s/#loopSecret/loopSecret/g" /opt/haraka/config/wildduck.yaml
  echo "user=wildduck" >> /opt/haraka/config/smtp.ini
  echo "group=wildduck" >> /opt/haraka/config/smtp.ini
fi

chown -R wildduck:wildduck /opt/haraka/queue /etc/zone-mta /etc/wildduck

mkdir -p /opt/zone-mta/keys
if [ ! -f "/opt/zone-mta/keys/${MAILDOMAIN}-dkim.pem" ]; then
  openssl genrsa -out "/opt/zone-mta/keys/${MAILDOMAIN}-dkim.pem" 1024
  chmod 0400 "/opt/zone-mta/keys/${MAILDOMAIN}-dkim.pem"
  openssl rsa -in "/opt/zone-mta/keys/${MAILDOMAIN}-dkim.pem" -out "/opt/zone-mta/keys/${MAILDOMAIN}-dkim.cert" -pubout
fi

DKIM_DNS="v=DKIM1;k=rsa;p=$(grep -v -e '^-' "/opt/zone-mta/keys/${MAILDOMAIN}-dkim.cert" | tr -d "\n")"
DKIM_JSON="$(node -e 'const fs=require("fs"); console.log(JSON.stringify({domain: process.env.MAILDOMAIN, selector: process.env.DKIM_SELECTOR, description: "Default DKIM key for "+process.env.MAILDOMAIN, privateKey: fs.readFileSync("/opt/zone-mta/keys/"+process.env.MAILDOMAIN+"-dkim.pem", "utf8") }))')"
echo "$DKIM_JSON" > /etc/wildduck/dkim.json
cat > /etc/wildduck/dkim.txt <<EOT
${DKIM_SELECTOR}._domainkey.${MAILDOMAIN}. IN TXT "${DKIM_DNS}"
EOT

NAMESERVER_FILE="${DATA_DIR}/${MAILDOMAIN}-nameserver.txt"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"
fi
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="<PUBLIC_IP>"
fi
cat > "$NAMESERVER_FILE" <<EOT
NAMESERVER SETUP
================

When deploying a mail server, correctly configuring DNS records is essential
to ensure email delivery, client compatibility, and security. The records
below are tailored to this container setup.

MX
--
Add this MX record to the ${MAILDOMAIN} DNS zone:

${MAILDOMAIN}. IN MX 5 ${WILDDUCK_HOSTNAME}.

SPF
---
Add this TXT record to the ${MAILDOMAIN} DNS zone:

${MAILDOMAIN}. IN TXT "v=spf1 a:${WILDDUCK_HOSTNAME} a:${MAILDOMAIN} ip4:${PUBLIC_IP} ~all"

Or:
${MAILDOMAIN}. IN TXT "v=spf1 a:${WILDDUCK_HOSTNAME} ip4:${PUBLIC_IP} ~all"
${MAILDOMAIN}. IN TXT "v=spf1 ip4:${PUBLIC_IP} ~all"

Optional (mail host SPF):
${WILDDUCK_HOSTNAME}. IN TXT "v=spf1 a ip4:${PUBLIC_IP} ~all"

DKIM
----
Add this TXT record to the ${MAILDOMAIN} DNS zone:

${DKIM_SELECTOR}._domainkey.${MAILDOMAIN}. IN TXT "${DKIM_DNS}"

The DKIM .json text we added to wildduck server:
    curl -i -XPOST http://localhost:8080/dkim \\
    -H 'Content-type: application/json' \\
    -d '$DKIM_JSON'

List DKIM keys:
    curl -i http://localhost:8080/dkim
Delete DKIM:
    curl -i -XDELETE http://localhost:8080/dkim/<id>

DMARC
-----
Add this TXT record to the ${MAILDOMAIN} DNS zone:

_dmarc.${MAILDOMAIN}. IN TXT "v=DMARC1; p=reject;"

Example with reporting:
_dmarc.${MAILDOMAIN}. IN TXT "v=DMARC1; p=reject; rua=mailto:postmaster@${MAILDOMAIN}; ruf=mailto:postmaster@${MAILDOMAIN}"

MTA-STS
-------
These records enforce TLS for incoming mail. You must also host a policy file
at https://mta-sts.${MAILDOMAIN}/.well-known/mta-sts.txt

mta-sts.${MAILDOMAIN}. IN CNAME ${WILDDUCK_HOSTNAME}.
_mta-sts.${MAILDOMAIN}. IN TXT "v=STSv1; id=20240101000000"

TLS-RPT
-------
_smtp._tls.${MAILDOMAIN}. IN TXT "v=TLSRPTv1; rua=mailto:postmaster@${MAILDOMAIN}"

SRV (client auto-discovery)
---------------------------
_imaps._tcp.${MAILDOMAIN}. IN SRV 0 1 993 ${WILDDUCK_HOSTNAME}.
_submissions._tcp.${MAILDOMAIN}. IN SRV 0 1 465 ${WILDDUCK_HOSTNAME}.

PTR
---
Make sure that your public IP has a PTR record set to ${WILDDUCK_HOSTNAME}.
If your hosting provider does not allow you to set PTR records but has
assigned their own hostname, then edit /etc/zone-mta/pools.toml and replace
the hostname ${WILDDUCK_HOSTNAME} with the actual hostname of this server.

TL;DR
-----
${MAILDOMAIN}. IN MX 5 ${WILDDUCK_HOSTNAME}.
${MAILDOMAIN}. IN TXT "v=spf1 ip4:${PUBLIC_IP} ~all"
${DKIM_SELECTOR}._domainkey.${MAILDOMAIN}. IN TXT "${DKIM_DNS}"
_dmarc.${MAILDOMAIN}. IN TXT "v=DMARC1; p=reject;"
EOT

echo "DNS configuration (${NAMESERVER_FILE}):"
cat "$NAMESERVER_FILE"

mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
mkdir -p /etc/rspamd/override.d
cat > /etc/rspamd/override.d/dmarc.conf <<'EOT'
actions = {
    quarantine = "add_header";
    reject = "reject";
}
EOT
sed -i -e 's|access_log .*;|access_log /dev/stdout;|' -e 's|error_log .*;|error_log /dev/stderr info;|' /etc/nginx/nginx.conf || true
cat > "/etc/nginx/sites-available/${WILDDUCK_HOSTNAME}" <<EOT
server {
    listen 80;
    listen [::]:80;
    listen 443 ssl http2;
    listen [::]:443 ssl http2;

    server_name ${WILDDUCK_HOSTNAME};

    ssl_certificate /etc/wildduck/certs/fullchain.pem;
    ssl_certificate_key /etc/wildduck/certs/privkey.pem;

    location /api/events {
        proxy_http_version 1.1;
        gzip off;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header HOST \$http_host;
        proxy_set_header X-NginX-Proxy true;
        proxy_pass http://127.0.0.1:3000;
        proxy_redirect off;
    }

    location /webmail/send {
        client_max_body_size 15M;
        proxy_http_version 1.1;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header HOST \$http_host;
        proxy_set_header X-NginX-Proxy true;
        proxy_pass http://127.0.0.1:3000;
        proxy_redirect off;
    }

    location / {
        proxy_http_version 1.1;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header HOST \$http_host;
        proxy_set_header X-NginX-Proxy true;
        proxy_pass http://127.0.0.1:3000;
        proxy_redirect off;
    }
}
EOT
rm -f /etc/nginx/sites-enabled/default
ln -sf "/etc/nginx/sites-available/${WILDDUCK_HOSTNAME}" "/etc/nginx/sites-enabled/${WILDDUCK_HOSTNAME}"

if [ "$DISABLE_CLAMAV" != "1" ]; then
  mkdir -p /var/run/clamav /var/lib/clamav
  chown -R clamav:clamav /var/run/clamav /var/lib/clamav
  if [ ! -f /var/lib/clamav/main.cvd ] && [ ! -f /var/lib/clamav/main.cld ]; then
    freshclam --stdout || true
  fi
fi

if [ "$DISABLE_RSPAMD" != "1" ]; then
  mkdir -p /var/run/rspamd /var/lib/rspamd
  chown -R _rspamd:_rspamd /var/run/rspamd /var/lib/rspamd
fi

cp /etc/supervisor/supervisord.base.conf /etc/supervisor/supervisord.conf
if [ "$DISABLE_RSPAMD" = "1" ]; then
  sed -i -e '/^\[program:rspamd\]/,/^\[/{d;}' /etc/supervisor/supervisord.conf
fi
if [ "$DISABLE_CLAMAV" = "1" ]; then
  sed -i -e '/^\[program:clamd\]/,/^\[/{d;}' /etc/supervisor/supervisord.conf
  sed -i -e '/^\[program:freshclam\]/,/^\[/{d;}' /etc/supervisor/supervisord.conf
fi
if [ "$ACME_ENABLED" = "1" ]; then
  cat >> /etc/supervisor/supervisord.conf <<'EOT'

[program:acme-renew]
command=/usr/local/bin/acme-renew
priority=95
autorestart=true
startsecs=0
startretries=0
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0
EOT
fi

exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
EOF
RUN chmod +x /usr/local/bin/wildduck-entrypoint

RUN cat > /etc/supervisor/supervisord.base.conf <<'EOF'
[supervisord]
nodaemon=true
logfile=/dev/null
pidfile=/tmp/supervisord.pid

[program:mongod]
command=/usr/bin/mongod --config /etc/mongod.conf --logpath /dev/stdout --logappend --logRotate reopen
priority=10
autorestart=true
startsecs=5
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0

[program:redis]
command=/usr/bin/redis-server /etc/redis/redis.conf --logfile "" --loglevel notice
priority=15
autorestart=true
startsecs=2
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0

[program:rspamd]
command=/usr/bin/rspamd -f -u _rspamd -g _rspamd
priority=20
autorestart=true
startsecs=2
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0

[program:clamd]
command=/usr/sbin/clamd -F
priority=25
autorestart=true
startsecs=2
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0

[program:freshclam]
command=/usr/bin/freshclam --foreground --stdout
priority=26
autorestart=unexpected
startsecs=2
exitcodes=0
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0

[program:wildduck]
command=/usr/bin/node /opt/wildduck/server.js --config=/etc/wildduck/wildduck.toml
environment=NODE_ENV="production"
priority=30
autorestart=true
startsecs=5
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0

[program:haraka]
command=/usr/bin/node /opt/haraka/node_modules/.bin/haraka -c /opt/haraka
environment=NODE_ENV="production"
priority=35
autorestart=true
startsecs=3
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0

[program:zone-mta]
command=/usr/bin/node /opt/zone-mta/index.js --config=/etc/zone-mta/zonemta.toml
directory=/opt/zone-mta
environment=NODE_ENV="production"
priority=40
autorestart=true
startsecs=3
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0

[program:wildduck-webmail]
command=/usr/bin/node /opt/wildduck-webmail/server.js --config=/etc/wildduck/wildduck-webmail.toml
environment=NODE_ENV="production"
priority=45
autorestart=true
startsecs=3
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0

[program:nginx]
command=/usr/sbin/nginx -g "daemon off; error_log /dev/stderr info;"
priority=50
autorestart=true
startsecs=2
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0

[program:register-dkim]
command=/usr/local/bin/register-dkim
priority=90
autorestart=false
startsecs=0
startretries=0
exitcodes=0
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0
EOF

EXPOSE 25 80 443 465 993 995 8080

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/wildduck-entrypoint"]
