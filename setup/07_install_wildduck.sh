#! /bin/bash

OURNAME=07_install_wildduck.sh

echo -e "\n-- Executing ${ORANGE}${OURNAME}${NC} subscript --"

####### WILD DUCK #######

# clear previous install
if [ -f "/etc/systemd/system/wildduck.service" ]
then
    $SYSTEMCTL_PATH stop wildduck || true
    $SYSTEMCTL_PATH disable wildduck || true
    rm -rf /etc/systemd/system/wildduck.service
fi
rm -rf /var/opt/wildduck.git
rm -rf /opt/wildduck
rm -rf /etc/wildduck

# fresh install
cd /var/opt
git clone --bare https://github.com/zone-eu/wildduck.git

# create update hook so we can later deploy to this location
hook_script wildduck

# allow deploy user to restart wildduck service
echo "deploy ALL = (root) NOPASSWD: $SYSTEMCTL_PATH restart wildduck" >> /etc/sudoers.d/wildduck

# checkout files from git to working directory
mkdir -p /opt/wildduck
git --git-dir=/var/opt/wildduck.git --work-tree=/opt/wildduck checkout $(get_latest_release_commit "wildduck")
cp -r /opt/wildduck/config /etc/wildduck
mv /etc/wildduck/default.toml /etc/wildduck/wildduck.toml

# enable example message
sed -i -e 's/"disabled": true/"disabled": false/g' /opt/wildduck/emails/00-example.json

# update ports
sed -i -e "s/999/99/g;s/localhost/$HOSTNAME/g" /etc/wildduck/imap.toml
sed -i -e "s/999/99/g;s/localhost/$HOSTNAME/g" /etc/wildduck/pop3.toml

echo "enabled=true
port=24
disableSTARTTLS=true" > /etc/wildduck/lmtp.toml

# make sure that DKIM keys are not stored to database as cleartext
echo "secret=\"$DKIM_SECRET\"" >> /etc/wildduck/dkim.toml

echo "user=\"wildduck\"
group=\"wildduck\"
emailDomain=\"$MAILDOMAIN\"" | cat - /etc/wildduck/wildduck.toml > temp && mv temp /etc/wildduck/wildduck.toml

sed -i -e "s/localhost:3000/$HOSTNAME/g;s/localhost/$HOSTNAME/g;s/2587/587/g" /etc/wildduck/wildduck.toml
sed -i -e "s/secret value/$SRS_SECRET/g;s/#loopSecret/loopSecret/g" /etc/wildduck/sender.toml

cd /opt/wildduck
npm install --omit=dev --omit=optional --no-package-lock --no-audit --ignore-scripts --no-shrinkwrap

chown -R deploy:deploy /var/opt/wildduck.git
chown -R deploy:deploy /opt/wildduck

echo "d /opt/wildduck 0755 deploy deploy
d /etc/wildduck 0755 wildduck wildduck" > /etc/tmpfiles.d/zone-mta.conf
log_script "wildduck-server"

echo "[Unit]
Description=WildDuck Mail Server
Conflicts=cyrus.service dovecot.service
After=mongod.service redis.service

[Service]
Environment=\"NODE_ENV=production\"
WorkingDirectory=/opt/wildduck
ExecStart=$NODE_PATH server.js --config=\"/etc/wildduck/wildduck.toml\"
ExecReload=/bin/kill -HUP \$MAINPID
Type=simple
Restart=always
SyslogIdentifier=wildduck-server

[Install]
WantedBy=multi-user.target" > /etc/systemd/system/wildduck.service

$SYSTEMCTL_PATH enable wildduck.service
