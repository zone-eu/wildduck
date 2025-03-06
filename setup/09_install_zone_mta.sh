#! /bin/bash

OURNAME=09_install_zone_mta.sh

echo -e "\n-- Executing ${ORANGE}${OURNAME}${NC} subscript --"


#### ZoneMTA ####

# clear previous install
if [ -f "/etc/systemd/system/zone-mta.service" ]
then
    $SYSTEMCTL_PATH stop zone-mta || true
    $SYSTEMCTL_PATH disable zone-mta || true
    rm -rf /etc/systemd/system/zone-mta.service
fi
rm -rf /var/opt/zone-mta.git
rm -rf /var/opt/zonemta-wildduck.git
rm -rf /opt/zone-mta
rm -rf /etc/zone-mta

# fresh install
cd /var/opt
git clone --bare https://github.com/zone-eu/zone-mta-template.git zone-mta.git
git clone --bare https://github.com/nodemailer/zonemta-wildduck.git

# create update hooks so we can later deploy to this location
hook_script zone-mta
echo "#!/bin/bash
git --git-dir=/var/opt/zonemta-wildduck.git --work-tree=/opt/zone-mta/plugins/wildduck checkout "\$3" -f
cd /opt/zone-mta/plugins/wildduck
rm -rf package-lock.json
npm install --production --no-optional --no-package-lock --no-audit --ignore-scripts --no-shrinkwrap --progress=false
sudo $SYSTEMCTL_PATH restart zone-mta || echo \"Failed restarting service\"" > "/var/opt/zonemta-wildduck.git/hooks/update"
chmod +x "/var/opt/zonemta-wildduck.git/hooks/update"

# allow deploy user to restart zone-mta service
echo "deploy ALL = (root) NOPASSWD: $SYSTEMCTL_PATH restart zone-mta" >> /etc/sudoers.d/zone-mta

# checkout files from git to working directory
mkdir -p /opt/zone-mta
git --git-dir=/var/opt/zone-mta.git --work-tree=/opt/zone-mta checkout "$ZONEMTA_COMMIT"

mkdir -p /opt/zone-mta/plugins/wildduck
git --git-dir=/var/opt/zonemta-wildduck.git --work-tree=/opt/zone-mta/plugins/wildduck checkout "$WILDDUCK_ZONEMTA_COMMIT"

cp -r /opt/zone-mta/config /etc/zone-mta
sed -i -e 's/port=2525/port=587/g;s/host="127.0.0.1"/host="0.0.0.0"/g;s/authentication=false/authentication=true/g' /etc/zone-mta/interfaces/feeder.toml
rm -rf /etc/zone-mta/plugins/dkim.toml
echo '# @include "/etc/wildduck/dbs.toml"' > /etc/zone-mta/dbs-production.toml
echo 'user="wildduck"
group="wildduck"' | cat - /etc/zone-mta/zonemta.toml > temp && mv temp /etc/zone-mta/zonemta.toml

echo "[[default]]
address=\"0.0.0.0\"
name=\"$HOSTNAME\"" > /etc/zone-mta/pools.toml

echo "[\"modules/zonemta-loop-breaker\"]
enabled=\"sender\"
secret=\"$ZONEMTA_SECRET\"
algo=\"md5\"" > /etc/zone-mta/plugins/loop-breaker.toml

echo "[wildduck]
enabled=[\"receiver\", \"sender\", \"main\"]

# which interfaces this plugin applies to
interfaces=[\"feeder\"]

# optional hostname to be used in headers
# defaults to os.hostname()
hostname=\"$HOSTNAME\"

# SRS settings for forwarded emails

[wildduck.srs]
    # Handle rewriting of forwarded emails
    enabled=true
    # SRS secret value. Must be the same as in the MX side
    secret=\"$SRS_SECRET\"
    # SRS domain, must resolve back to MX
    rewriteDomain=\"$MAILDOMAIN\"

[wildduck.dkim]
# share config with WildDuck installation
# @include \"/etc/wildduck/dkim.toml\"
" > /etc/zone-mta/plugins/wildduck.toml

cd /opt/zone-mta/keys
# Many registrar limits dns TXT fields to 255 char. 1024bit is almost too long:-\
openssl genrsa -out "$MAILDOMAIN-dkim.pem" 1024
chmod 400 "$MAILDOMAIN-dkim.pem"
openssl rsa -in "$MAILDOMAIN-dkim.pem" -out "$MAILDOMAIN-dkim.cert" -pubout
DKIM_DNS="v=DKIM1;k=rsa;p=$(grep -v -e '^-' $MAILDOMAIN-dkim.cert | tr -d "\n")"

DKIM_JSON=`DOMAIN="$MAILDOMAIN" SELECTOR="$DKIM_SELECTOR" node -e 'console.log(JSON.stringify({
  domain: process.env.DOMAIN,
  selector: process.env.SELECTOR,
  description: "Default DKIM key for "+process.env.DOMAIN,
  privateKey: fs.readFileSync("/opt/zone-mta/keys/"+process.env.DOMAIN+"-dkim.pem", "UTF-8")
}))'`

cd /opt/zone-mta
npm install --production --no-optional --no-package-lock --no-audit --ignore-scripts --no-shrinkwrap --unsafe-perm

cd /opt/zone-mta/plugins/wildduck
npm install --production --no-optional --no-package-lock --no-audit --ignore-scripts --no-shrinkwrap --unsafe-perm

chown -R deploy:deploy /var/opt/zone-mta.git
chown -R deploy:deploy /var/opt/zonemta-wildduck.git
chown -R deploy:deploy /opt/zone-mta
chown -R wildduck:wildduck /etc/zone-mta

# Ensure required files and permissions
echo "d /opt/zone-mta 0755 deploy deploy
d /etc/zone-mta 0755 wildduck wildduck" > /etc/tmpfiles.d/zone-mta.conf
log_script "zone-mta"

echo '[Unit]
Description=Zone Mail Transport Agent
Conflicts=sendmail.service exim.service postfix.service
After=mongod.service redis.service

[Service]
Environment="NODE_ENV=production"
WorkingDirectory=/opt/zone-mta
ExecStart=/usr/bin/node index.js --config="/etc/zone-mta/zonemta.toml"
ExecReload=/bin/kill -HUP $MAINPID
Type=simple
Restart=always
SyslogIdentifier=zone-mta

[Install]
WantedBy=multi-user.target' > /etc/systemd/system/zone-mta.service

$SYSTEMCTL_PATH enable zone-mta.service
