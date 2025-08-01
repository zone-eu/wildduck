#! /bin/bash

OURNAME=10_install_wildduck_webmail.sh

echo -e "\n-- Executing ${ORANGE}${OURNAME}${NC} subscript --"

#### WWW ####
####
# clear previous install
if [ -f "/etc/systemd/system/wildduck-webmail.service" ]
then
    $SYSTEMCTL_PATH stop wildduck-webmail || true
    $SYSTEMCTL_PATH disable wildduck-webmail || true
    rm -rf /etc/systemd/system/wildduck-webmail.service
fi
rm -rf /var/opt/wildduck-webmail.git
rm -rf /opt/wildduck-webmail

# fresh install
cd /var/opt
git clone --bare https://github.com/nodemailer/wildduck-webmail.git

# create update hook so we can later deploy to this location
hook_script_bower wildduck-webmail
chmod +x /var/opt/wildduck-webmail.git/hooks/update

# allow deploy user to restart zone-mta service
echo "deploy ALL = (root) NOPASSWD: $SYSTEMCTL_PATH restart wildduck-webmail" >> /etc/sudoers.d/wildduck-webmail

# checkout files from git to working directory
mkdir -p /opt/wildduck-webmail
git --git-dir=/var/opt/wildduck-webmail.git --work-tree=/opt/wildduck-webmail checkout $(get_latest_release_commit "wildduck-webmail")
cp /opt/wildduck-webmail/config/default.toml /etc/wildduck/wildduck-webmail.toml

sed -i -e "s/localhost/$HOSTNAME/g;s/999/99/g;s/2587/587/g;s/proxy=false/proxy=true/g;s/domains=.*/domains=[\"$MAILDOMAIN\"]/g" /etc/wildduck/wildduck-webmail.toml

cd /opt/wildduck-webmail

chown -R deploy:deploy /var/opt/wildduck-webmail.git
chown -R deploy:deploy /opt/wildduck-webmail

# we need to run bower which reject root
HOME=/home/deploy sudo -u deploy npm install
HOME=/home/deploy sudo -u deploy npm run bowerdeps


echo "d /opt/wildduck-webmail 0755 deploy deploy" > /etc/tmpfiles.d/zone-mta.conf
log_script "wildduck-www"

echo '[Unit]
Description=Wildduck Webmail
After=wildduck.service

[Service]
Environment="NODE_ENV=production"
WorkingDirectory=/opt/wildduck-webmail
ExecStart=/usr/bin/node server.js --config="/etc/wildduck/wildduck-webmail.toml"
ExecReload=/bin/kill -HUP $MAINPID
Type=simple
Restart=always
SyslogIdentifier=wildduck-www

[Install]
WantedBy=multi-user.target' > /etc/systemd/system/wildduck-webmail.service

$SYSTEMCTL_PATH enable wildduck-webmail.service
