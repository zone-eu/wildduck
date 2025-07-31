#! /bin/bash

OURNAME=04_install_import_keys.sh

echo -e "\n-- Executing ${ORANGE}${OURNAME}${NC} subscript --"

# create user for running applications
useradd wildduck || echo "User wildduck already exists"

# remove old sudoers file
rm -rf /etc/sudoers.d/wildduck

# create user for deploying code
useradd deploy || echo "User deploy already exists"

mkdir -p /home/deploy/.ssh
# add your own key to the authorized_keys file
echo "# Add your public key here
" >> /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy

export DEBIAN_FRONTEND=noninteractive
keyring="/usr/share/keyrings"

# nodejs
node_key_url="https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"
local_node_key="${keyring}/nodesource.gpg"
curl -fsSL $node_key_url | gpg --dearmor | tee $local_node_key >/dev/null

echo "deb [arch=${ARCHITECTURE} signed-by=${local_node_key}] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
echo "deb-src [arch=${ARCHITECTURE} signed-by=${local_node_key}] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" >> /etc/apt/sources.list.d/nodesource.list

# mongodb
mongo_key_url="https://pgp.mongodb.com/server-${MONGODB}.asc"
local_mongo_key="${keyring}/mongodb-server-${MONGODB}.gpg"
curl -fsSL $mongo_key_url | gpg --dearmor | tee ${local_mongo_key} >/dev/null
echo "deb [ arch=${ARCHITECTURE} signed-by=${local_mongo_key} ] https://repo.mongodb.org/apt/ubuntu ${CODENAME}/mongodb-org/${MONGODB} multiverse" > /etc/apt/sources.list.d/mongodb-org-${MONGODB}.list

# rspamd
rspamd_key_url="https://rspamd.com/apt-stable/gpg.key"
local_rspamd_key="${keyring}/rspamd.gpg"
curl -fsSL $rspamd_key_url | gpg --dearmor | tee ${local_rspamd_key} >/dev/null

echo "deb [signed-by=${local_rspamd_key}] http://rspamd.com/apt-stable/ $CODENAME main" > /etc/apt/sources.list.d/rspamd.list
echo "deb-src [signed-by=${local_rspamd_key}] http://rspamd.com/apt-stable/ $CODENAME main" >> /etc/apt/sources.list.d/rspamd.list

# redis
redis_key_url="https://packages.redis.io/gpg"
local_redis_key="${keyring}/redis-archive-keyring.gpg"
curl -fsSL $redis_key_url | gpg --dearmor | tee ${local_redis_key} >/dev/null

echo "deb [signed-by=${local_redis_key}] https://packages.redis.io/deb $CODENAME main" > tee /etc/apt/sources.list.d/redis.list

apt-get update