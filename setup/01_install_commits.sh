#! /bin/bash

OURNAME=01_install_commits.sh

apt-get update
apt-get install -y lsb-release ca-certificates curl gnupg

NODE_MAJOR="22"
MONGODB="8.0"
CODENAME=`lsb_release -c -s`

HARAKA_VERSION="3.0.5"

ARCHITECTURE=$(dpkg --print-architecture)
if [ "$ARCHITECTURE" != "amd64" ] && [ "$ARCHITECTURE" != "arm64" ] && [ "$ARCHITECTURE" != "armhf" ]; then
	handle_error "1" "Unsupported architecture: $ARCHITECTURE. Only amd64, arm64, and armhf are supported."
fi

echo -e "\n-- Executing ${ORANGE}${OURNAME}${NC} subscript --"
