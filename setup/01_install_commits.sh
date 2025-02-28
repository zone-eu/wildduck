#! /bin/bash

OURNAME=01_install_commits.sh

apt-get update
apt-get install -y lsb-release ca-certificates curl gnupg

NODE_MAJOR="20"
MONGODB="7.0"
CODENAME=`lsb_release -c -s`

WILDDUCK_COMMIT="9a204f5751ad2bd80baaa3abca95f334fbdf0757"
ZONEMTA_COMMIT="0df73a3946eae0964a166b3015d3ed558d9d024f" # zone-mta-template
WEBMAIL_COMMIT="093cc641782c1a9ca4f498b24ebded23873cb390"
WILDDUCK_ZONEMTA_COMMIT="1f4fad5ba771ce381ef0543e8c9c49ee25e4a6f2"
WILDDUCK_HARAKA_COMMIT="91745b5af70e1d3dfd0fac22d9550f893662ad70"
HARAKA_VERSION="3.0.5"

echo -e "\n-- Executing ${ORANGE}${OURNAME}${NC} subscript --"
