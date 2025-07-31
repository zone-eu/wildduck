#! /bin/bash

# These are all the common global variables and global functions.

AUT_HOSTNAME=`hostname`
export AUT_SAFETY=true

export AUT_HOME="${HOME}" # maybe a more robust way?

# COLOR VARIABLES
export RED='\033[0;31m'
export GREEN='\033[0;32m'
export ORANGE='\033[0;33m'
export YELLOW='\033[1;33m'
export BLUE='\033[0;34m'
export NC='\033[0m' # No Color

# GLOBAL FUNCTIONS

fun_get_password(){
# If we are not root, we should acquire the sudo password
if [ `whoami` == 'root' ]
  then
    PASSWORD=''
  else
    echo -n "GIMME your password! ($OURNAME):"
    read -s PASSWORD
    echo -e "\n"
fi
}
export -f fun_get_password

fun_check_password_boolean(){
# Check if the $PASSWORD is good or not

# TODO: if hostname can not be resolved (/etc/hosts misses 127.0.0.1)
# then sudo outputs 'cannot resolve hostname', so this check
# "obviously" fails.

sudo -k #disable sudo timeout

#prime it
echo $PASSWORD | sudo -S echo hello &> /dev/null

local RESULT=$(echo $PASSWORD | sudo -S sudo -n echo hello 2>&1)
if [ "$RESULT" == "hello" ]; then
  echo 'Correct password.'
  return 0
else
  echo 'Wrong password.'
  return 1
fi

}
export -f fun_check_password_boolean

fun_check_password(){
if ! fun_check_password_boolean; then
  echo -e "${RED}ERROR:${NC} Wrong password, we should quit now."
  exit 1
fi
}
export -f fun_check_password


fun_get_user_variables_no_default(){
# get REMOTE_SERVER_EMAIL, if not supplied, quit. No default.

local VARIABLES=("${!1}")
local TMP_DEFAULT
local TMP_USER
local TMP_READ

echo "Automatic timeout is 120 sec"

for i in ${VARIABLES[@]}; do
  TMP_DEFAULT=DEFAULT_$i
  echo -n "GIMMME the $i (username, eg: ${!TMP_DEFAULT}), no default value:"
  read -t 120 TMP_READ
  echo ""
  declare -g USER_$i=$TMP_READ
  TMP_USER=USER_$i

  if [ "${!TMP_USER}" == "" ]; then
    echo -n "${TMP_USER} can not be empty. Please give it again:"
    read -t 130 TMP_READ
    declare -g USER_$i=$TMP_READ
    TMP_USER=USER_$i
    if [ "${!TMP_USER}" == "" ]; then
      echo "Second try failed. Quitting..."
      exit 1
    fi
  fi
done

}
export -f fun_get_user_variables_no_default

fun_get_user_variables_password(){
# get REMOTE_SERVER_PASSWORD, no default, suppress echoing back

local VARIABLES=("${!1}")
local TMP_DEFAULT
local TMP_USER
local TMP_READ

echo "Automatic timeout is 120 sec"

for i in ${VARIABLES[@]}; do
  TMP_DEFAULT=DEFAULT_$i
  echo -n "GIMMME the $i (password, eg: ${!TMP_DEFAULT}), no default value:"
  read -t 120 -s TMP_READ
  echo ""
  declare -g USER_$i=$TMP_READ
  TMP_USER=USER_$i

  if [ "${!TMP_USER}" == "" ]; then
    echo -n "${TMP_USER} can not be empty. Please give it again:"
    read -t 130 -s TMP_READ
    declare -g USER_$i=$TMP_READ
    TMP_USER=USER_$i
    if [ "${!TMP_USER}" == "" ]; then
      echo "Second try failed. Quitting..."
      exit 1
    fi
  fi
done
}
export -f fun_get_user_variables_password

fun_get_user_variables(){
# get USER_HOST_PORT, if not supplied, autofill with DEFAULT_HOST_PORT, etc

local VARIABLES=("${!1}")
local TMP_DEFAULT
local TMP_USER
local TMP_READ

echo "Automatic timeout is 30 sec"

for i in ${VARIABLES[@]}; do
  TMP_DEFAULT=DEFAULT_$i
  echo -n "GIMMME the $i (default: ${!TMP_DEFAULT}):"
  read -t 30 TMP_READ
  echo ""
  declare -g USER_$i=$TMP_READ
  TMP_USER=USER_$i

  if [ "${!TMP_USER}" == "" ]; then
    declare -g USER_$i=${!TMP_DEFAULT}
  fi
done
}
export -f fun_get_user_variables


fun_prepare_run_command(){
# prepare the runcommand variable.
# Must be called before fun_echo_command and fun_run_command

TEMPLATE=$(cat <<EOF
-e "ORIGINAL_COMMAND=RUNCOMMAND_TEMPLATE" \
$USER_IMAGE
EOF
)

RUNCOMMAND_ADDED_ENV=${RUNCOMMAND_ORIG//$USER_IMAGE/$TEMPLATE}
RUNCOMMAND_NOPASSWD=${RUNCOMMAND_ADDED_ENV//$PASSWORD/PASSWORD}
RUNCOMMAND=${RUNCOMMAND_ADDED_ENV//RUNCOMMAND_TEMPLATE/$RUNCOMMAND_NOPASSWD}

}
export -f fun_prepare_run_command

fun_echo_command(){
# echo the command which will be launched (fun_run_command())

echo ${RUNCOMMAND//$PASSWORD/PASSWORD}

}
export -f fun_echo_command

fun_run_command(){
# execute the final command

echo `eval $RUNCOMMAND`
}
export -f fun_run_command

fun_print_help(){
USAGE=$(cat <<EOF

# Manual
# The main installation script is:
./install.sh domainname [hostname]
eg. ${GREEN}./install.sh amazeme.com mail.amazeme.com${NC}

There is a slight difference between domainname and hostname.

${ORANGE}Simplest case${NC}:
One server serves everything: company website, emails, webmails.
One ip address, and domainname is the same az hostname.
Eg. amazme.com

${GREEN}More general case${NC}:
The domainname is part of the email address:
username@domainname

The hostname is the actual machine name, eg. this machine
name is: `hostname`

On larger organizations, the company homepage is independent from
the mail servers. Or the webmail servers.
Eg. the company homepage is amazme.com [11.22.33.44],
the mail server is mail.amazme.com [11.22.33.43]

So domainname = amazme.com
hostname = mail.amazme.com

${RED}IP address${NC} case:
You can call this script with ip address instead of domain name:
./install.sh 11.22.33.44
(with the server's public IP address)
In that case both domainname and hostname becomes the IP address.
Dunno why anyone wanna that...

EOF
)

# echo -e for the colored output, "quotes" for the newline preserves
echo -e "$USAGE"
}
export -f fun_print_help

function hook_script {
    echo "#!/bin/bash
git --git-dir=/var/opt/$1.git --work-tree=\"/opt/$1\" checkout "\$3" -f
cd \"/opt/$1\"
rm -rf package-lock.json
npm install --production --no-optional --no-package-lock --no-audit --ignore-scripts --no-shrinkwrap --progress=false
sudo $SYSTEMCTL_PATH restart $1 || echo \"Failed restarting service\"" > "/var/opt/$1.git/hooks/update"
    chmod +x "/var/opt/$1.git/hooks/update"
}
export -f hook_script

function hook_script_bower {
    echo "#!/bin/bash
git --git-dir=/var/opt/$1.git --work-tree=\"/opt/$1\" checkout "\$3" -f
cd \"/opt/$1\"
rm -rf package-lock.json
npm install --progress=false
npm run bowerdeps
sudo $SYSTEMCTL_PATH restart $1 || echo \"Failed restarting service\"" > "/var/opt/$1.git/hooks/update"
    chmod +x "/var/opt/$1.git/hooks/update"
}
export -f hook_script_bower

function log_script {

SERVICE_NAME=$1

# Ensure required files and permissions
echo "d /var/log/${SERVICE_NAME} 0750 syslog adm" > /etc/tmpfiles.d/${SERVICE_NAME}-log.conf

# Redirect MongoDB log output from syslog to service specific log file
echo "if ( \$programname startswith \"$SERVICE_NAME\" ) then {
    action(type=\"omfile\" file=\"/var/log/${SERVICE_NAME}/${SERVICE_NAME}.log\")
    stop
}" > /etc/rsyslog.d/25-${SERVICE_NAME}.conf

# Setup log rotate
echo "/var/log/${SERVICE_NAME}/${SERVICE_NAME}.log {
    daily
    ifempty
    missingok
    rotate 7
    compress
    create 640 syslog adm
    su root root
    sharedscripts
    postrotate
        systemctl kill --signal=SIGHUP --kill-who=main rsyslog.service 2>/dev/null || true
    endscript
}" > /etc/logrotate.d/${SERVICE_NAME}

}

export -f log_script

function get_latest_release_commit {
    REPO_NAME="$1"
    GIT_DIR="/var/opt/${REPO_NAME}.git"
    git --git-dir="$GIT_DIR" fetch --tags
    LATEST_TAG=$(git --git-dir="$GIT_DIR" describe --tags $(git --git-dir="$GIT_DIR" rev-list --tags --max-count=1))
    LATEST_COMMIT=$(git --git-dir="$GIT_DIR" rev-list -n 1 "$LATEST_TAG")
    echo "$LATEST_COMMIT"
}
export -f get_latest_release_commit