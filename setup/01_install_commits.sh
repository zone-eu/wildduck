#! /bin/bash

OURNAME=01_install_commits.sh

apt-get update
apt-get install -y lsb-release ca-certificates curl gnupg

NODE_MAJOR="20"
MONGODB="7.0"
CODENAME=`lsb_release -c -s`

HARAKA_VERSION="3.0.5"

echo -e "\n-- Executing ${ORANGE}${OURNAME}${NC} subscript --"
