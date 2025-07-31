#! /bin/bash

OURNAME=02_install_prerequisites.sh

# No $AUT_SAFETY variable present, so we have not sourced 00_install_global_functions_variables.sh yet
if [ -z ${AUT_SAFETY+x} ]
  then
    echo "this script ${RED}called directly${NC}, and not from the main ./install.sh script"
    echo "initializing common variables ('00_install_global_functions_variables.sh')"
    source "$INSTALLDIR/00_install_global_functions_variables.sh"
fi

echo -e "\n-- Executing ${ORANGE}${OURNAME}${NC} subscript --"

echo -e "Checking ${YELLOW}lsof${NC}"
PROGRAM_LSOF=`command -v lsof`

if ! [ -x "$PROGRAM_LSOF" ]; then
  echo -e "${RED}ERROR:${NC} lsof is not installed."
  echo    "to know which package contains the particular executable, launch:"
  echo    "dpkg -S lsof |grep lsof$ # on ubuntu/debian variants"
  echo -e "Launching for you:\n"
  echo -e "`dpkg -S lsof | grep /lsof$`"
  echo -e "\nOn ubuntu 16.04 it is: ${GREEN}apt install lsof${NC}"
fi


echo -e "Checking ${YELLOW}ps${NC}"
PROGRAM_PS=`command -v ps`

if ! [ -x "$PROGRAM_PS" ]; then
  echo -e "${RED}ERROR:${NC} ps is not installed."
  echo    "to know which package contains the particular executable, launch:"
  echo    "dpkg -S ps |grep ps$ # on ubuntu/debian variants"
  echo -e "Launching for you:\n"
  echo -e "`dpkg -S ps | grep /ps$`"
  echo -e "\nOn ubuntu 16.04 it is: ${GREEN}apt install procps${NC}"
fi
