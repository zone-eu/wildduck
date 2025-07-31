#! /bin/bash

OURNAME=03_install_check_running_services.sh

# No $AUT_SAFETY variable present, so we have not sourced 00_install_global_functions_variables.sh yet
# check if $AUT_SAFETY is unset (as opposed to empty "" string)
if [ -z ${AUT_SAFETY+x} ]
  then
    echo "this script ${RED}called directly${NC}, and not from the main ./install.sh script"
    echo "initializing common variables ('00_install_global_functions_variables.sh')"
    source "$INSTALLDIR/00_install_global_functions_variables.sh"
fi

echo -e "\n\n-- Executing ${ORANGE}${OURNAME}${NC} subscript --"

echo -e "Checking programs listening on port 25,587,993,995,80,443"
PORT25=`lsof -Pi :25 -sTCP:LISTEN -t`
PORT587=`lsof -Pi :587 -sTCP:LISTEN -t`
PORT993=`lsof -Pi :993 -sTCP:LISTEN -t`
PORT995=`lsof -Pi :995 -sTCP:LISTEN -t`
PORT80=`lsof -Pi :80 -sTCP:LISTEN -t`
PORT443=`lsof -Pi :443 -sTCP:LISTEN -t`


# check if $PORT25 is empty "" string (as opposed to unset)
if  ! [ -z $PORT25 ] ; then
    echo -e "${RED}Error:${NC} SMTP server already running on port 25"
    echo -e "PID: ${YELLOW}$PORT25${NC}"
    BINARY=`ps -p $PORT25 -o comm=`
    echo -e "binary: ${YELLOW}$BINARY${NC}"
    echo -e "full command with arguments: ${YELLOW}`ps -p $PORT25 -o command=`${NC}"
    echo -e "possible packages (dpkg -S $BINARY | grep /${BINARY}$):"
    echo -e "`dpkg -S $BINARY | grep /${BINARY}$`"
    echo -e "If it is launched by systemd, finding the service with"
    echo -e "Executing ${YELLOW}systemctl status $PORT25${NC}"
    echo -e "`systemctl status $PORT25`"
    echo -e "\nList all enabled services:"
    echo -e "systemctl list-unit-files | grep enabled"
    echo -e "stop a service: systemctl stop [service]"
    echo -e "${RED}QUITTING... (please stop the service and launch again)${NC}"
    exit 1
  else
    echo -e 'OK: port 25 (SMTP) is free'
fi

if  ! [ -z $PORT587 ] ; then
    echo -e "${RED}Error:${NC} SMTP server already running on port 587"
    echo -e "PID: ${YELLOW}$PORT587${NC}"
    BINARY=`ps -p $PORT587 -o comm=`
    echo -e "binary: ${YELLOW}$BINARY${NC}"
    echo -e "full command with arguments: ${YELLOW}`ps -p $PORT587 -o command=`${NC}"
    echo -e "possible packages (dpkg -S $BINARY | grep /${BINARY}$):"
    echo -e "`dpkg -S $BINARY | grep /${BINARY}$`"
    echo -e "If it is launched by systemd, finding the service with"
    echo -e "Executing ${YELLOW}systemctl status $PORT587${NC}"
    echo -e "`systemctl status $PORT587`"
    echo -e "\nList all enabled services:"
    echo -e "systemctl list-unit-files | grep enabled"
    echo -e "stop a service: systemctl stop [service]"
    echo -e "${RED}QUITTING... (please stop the service and launch again)${NC}"
    exit 1
  else
    echo -e 'OK: port 587 (SMTP TLS) is free'
fi

if  ! [ -z $PORT993 ] ; then
    echo -e "${RED}Error:${NC} IMAP server already running on port 993"
    echo -e "PID: ${YELLOW}$PORT993${NC}"
    BINARY=`ps -p $PORT993 -o comm=`
    echo -e "binary: ${YELLOW}$BINARY${NC}"
    echo -e "full command with arguments: ${YELLOW}`ps -p $PORT993 -o command=`${NC}"
    echo -e "possible packages (dpkg -S $BINARY | grep /${BINARY}$):"
    echo -e "`dpkg -S $BINARY | grep /${BINARY}$`"
    echo -e "If it is launched by systemd, finding the service with"
    echo -e "Executing ${YELLOW}systemctl status $PORT993${NC}"
    echo -e "`systemctl status $PORT993`"
    echo -e "\nList all enabled services:"
    echo -e "systemctl list-unit-files | grep enabled"
    echo -e "stop a service: systemctl stop [service]"
    echo -e "${RED}QUITTING... (please stop the service and launch again)${NC}"
    exit 1
  else
    echo -e 'OK: port 993 (IMAP SSL/TLS) is free'
fi

if  ! [ -z $PORT995 ] ; then
    echo -e "${RED}Error:${NC} POP3 server already running on port 995"
    echo -e "PID: ${YELLOW}$PORT995${NC}"
    BINARY=`ps -p $PORT995 -o comm=`
    echo -e "binary: ${YELLOW}$BINARY${NC}"
    echo -e "full command with arguments: ${YELLOW}`ps -p $PORT995 -o command=`${NC}"
    echo -e "possible packages (dpkg -S $BINARY | grep /${BINARY}$):"
    echo -e "`dpkg -S $BINARY | grep /${BINARY}$`"
    echo -e "If it is launched by systemd, finding the service with"
    echo -e "Executing ${YELLOW}systemctl status $PORT995${NC}"
    echo -e "`systemctl status $PORT995`"
    echo -e "\nList all enabled services:"
    echo -e "systemctl list-unit-files | grep enabled"
    echo -e "stop a service: systemctl stop [service]"
    echo -e "${RED}QUITTING... (please stop the service and launch again)${NC}"
    exit 1
  else
    echo -e 'OK: port 995 (POP3 SSL/TLS) is free'
fi

if  ! [ -z $PORT80 ] ; then
    echo -e "${RED}Error:${NC} HTTP server already running on port 80"
    echo -e "PID: ${YELLOW}$PORT80${NC}"
    BINARY=`ps -p $PORT80 -o comm=`
    echo -e "binary: ${YELLOW}$BINARY${NC}"
    echo -e "full command with arguments: ${YELLOW}`ps -p $PORT80 -o command=`${NC}"
    echo -e "possible packages (dpkg -S $BINARY | grep /${BINARY}$):"
    echo -e "`dpkg -S $BINARY | grep /${BINARY}$`"
    echo -e "If it is launched by systemd, finding the service with"
    echo -e "Executing ${YELLOW}systemctl status $PORT80${NC}"
    echo -e "`systemctl status $PORT80`"
    echo -e "\nList all enabled services:"
    echo -e "systemctl list-unit-files | grep enabled"
    echo -e "stop a service: systemctl stop [service]"
    echo -e "${RED}QUITTING... (please stop the service and launch again)${NC}"
    exit 1
  else
    echo -e 'OK: port 80 (HTTP) is free'
fi

if  ! [ -z $PORT443 ] ; then
    echo -e "${RED}Error:${NC} HTTPS server already running on port 443"
    echo -e "PID: ${YELLOW}$PORT443${NC}"
    BINARY=`ps -p $PORT443 -o comm=`
    echo -e "binary: ${YELLOW}$BINARY${NC}"
    echo -e "full command with arguments: ${YELLOW}`ps -p $PORT443 -o command=`${NC}"
    echo -e "possible packages (dpkg -S $BINARY | grep /${BINARY}$):"
    echo -e "`dpkg -S $BINARY | grep /${BINARY}$`"
    echo -e "If it is launched by systemd, finding the service with"
    echo -e "Executing ${YELLOW}systemctl status $PORT443${NC}"
    echo -e "`systemctl status $PORT443`"
    echo -e "\nList all enabled services:"
    echo -e "systemctl list-unit-files | grep enabled"
    echo -e "stop a service: systemctl stop [service]"
    echo -e "${RED}QUITTING... (please stop the service and launch again)${NC}"
    exit 1
  else
    echo -e 'OK: port 443 (HTTPS) is free'
fi
