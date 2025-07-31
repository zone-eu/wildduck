#! /bin/bash

OURNAME=08_install_haraka.sh

echo -e "\n-- Executing ${ORANGE}${OURNAME}${NC} subscript --"



####### HARAKA #######

# clear previous install
if [ -f "/etc/systemd/system/haraka.service" ]
then
    $SYSTEMCTL_PATH stop haraka || true
    $SYSTEMCTL_PATH disable haraka || true
    rm -rf /etc/systemd/system/haraka.service
fi
rm -rf /var/opt/haraka-plugin-wildduck.git
rm -rf /opt/haraka

# fresh install
cd /var/opt
git clone --bare https://github.com/zone-eu/haraka-plugin-wildduck.git
echo "#!/bin/bash
git --git-dir=/var/opt/haraka-plugin-wildduck.git --work-tree=/opt/haraka/plugins/wildduck checkout "\$3" -f
cd /opt/haraka/plugins/wildduck
rm -rf package-lock.json
npm install --omit=dev --omit=optional --no-package-lock --no-audit --ignore-scripts --no-shrinkwrap --progress=false
sudo $SYSTEMCTL_PATH restart haraka || echo \"Failed restarting service\"" > "/var/opt/haraka-plugin-wildduck.git/hooks/update"
chmod +x "/var/opt/haraka-plugin-wildduck.git/hooks/update"

# allow deploy user to restart wildduck service
echo "deploy ALL = (root) NOPASSWD: $SYSTEMCTL_PATH restart haraka" >> /etc/sudoers.d/wildduck

cd
npm install --omit=dev --omit=optional --no-package-lock --no-audit --no-shrinkwrap -g Haraka@$HARAKA_VERSION
haraka -i /opt/haraka
cd /opt/haraka
npm install --omit=dev --omit=optional --no-package-lock --no-audit --no-shrinkwrap --save haraka-plugin-rspamd haraka-plugin-redis Haraka@$HARAKA_VERSION

# Haraka WildDuck plugin. Install as separate repo as it can be edited more easily later
mkdir -p plugins/wildduck
git --git-dir=/var/opt/haraka-plugin-wildduck.git --work-tree=/opt/haraka/plugins/wildduck checkout $(get_latest_release_commit "haraka-plugin-wildduck")

cd plugins/wildduck
npm install --omit=dev --omit=optional --no-package-lock --no-audit --ignore-scripts --no-shrinkwrap --progress=false

cd /opt/haraka
mv config/plugins config/plugins.bak

echo "26214400" > config/databytes
echo "$HOSTNAME" > config/me
echo "WildDuck MX" > config/smtpgreeting

echo "#spf
#dkim_verify

## ClamAV is disabled by default. Make sure freshclam has updated all
## virus definitions and clamav-daemon has successfully started before
## enabling it.
#clamd

rspamd
tls

# WildDuck plugin handles recipient checking and queueing
wildduck" > config/plugins

echo "key=/etc/wildduck/certs/privkey.pem
cert=/etc/wildduck/certs/fullchain.pem" > config/tls.ini

echo 'host = localhost
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
neutral = /' > config/rspamd.ini

echo 'clamd_socket = /var/run/clamav/clamd.ctl
[reject]
virus=true
error=false' > config/clamd.ini

cp plugins/wildduck/config/wildduck.yaml config/wildduck.yaml
sed -i -e "s/secret value/$SRS_SECRET/g;s/#loopSecret/loopSecret/g" config/wildduck.yaml

# Ensure required files and permissions
echo "d /opt/haraka 0755 deploy deploy" > /etc/tmpfiles.d/haraka.conf
log_script "haraka"

echo '[Unit]
Description=Haraka MX Server
After=mongod.service redis.service

[Service]
Environment="NODE_ENV=production"
WorkingDirectory=/opt/haraka
ExecStart=/usr/bin/node ./node_modules/.bin/haraka -c .
Type=simple
Restart=always
SyslogIdentifier=haraka

[Install]
WantedBy=multi-user.target' > /etc/systemd/system/haraka.service

echo 'user=wildduck
group=wildduck' >> config/smtp.ini

chown -R deploy:deploy /opt/haraka
chown -R deploy:deploy /var/opt/haraka-plugin-wildduck.git

# ensure queue folder for Haraka
mkdir -p /opt/haraka/queue
chown -R wildduck:wildduck /opt/haraka/queue

$SYSTEMCTL_PATH enable haraka.service
