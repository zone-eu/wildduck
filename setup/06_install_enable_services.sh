#! /bin/bash

OURNAME=06_install_enable_services.sh

echo -e "\n-- Executing ${ORANGE}${OURNAME}${NC} subscript --"

NODE_PATH=`command -v node`
SYSTEMCTL_PATH=`command -v systemctl`

SRS_SECRET=`pwgen 12 -1`
DKIM_SECRET=`pwgen 12 -1`
ZONEMTA_SECRET=`pwgen 12 -1`
DKIM_SELECTOR=`$NODE_PATH -e 'console.log(Date().toString().substr(4, 3).toLowerCase() + new Date().getFullYear())'`

$SYSTEMCTL_PATH enable mongod.service
$SYSTEMCTL_PATH enable redis-server.service

echo -e "\n-- These are the installed and required programs:"
node -v
redis-server -v
mongod --version
echo "HOSTNAME: $HOSTNAME"

echo -e "-- Installing ${RED}npm globally${NC} (workaround)"
# See issue https://github.com/zone-eu/wildduck/issues/82
npm install npm -g
