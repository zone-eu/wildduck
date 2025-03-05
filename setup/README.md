# WildDuck Installer

Here you can find an example install script to install WildDuck with Haraka and ZoneMTA. The install script is self contained, you can upload to your server and start it as root. It fetches all required files from Github. After installation you should see exactly the same web interface as in https://webmail.wildduck.email/

The install script should work with Ubuntu version from 22.04 (probably also with 20.04) and the server must be blank. Blank meaning that there should be no existing software installed (eg. Apache, MySQL or Postfix). If the server already has something installed, then remove the extra applications before running this script. This also means that you should not run the install script in a VPS that you already use for other stuff.

## What does it do?

This install script installs and configures the following components:

1.  **WildDuck Mail Server** for IMAP and POP3
2.  **Haraka** with WildDuck plugin for incoming email
3.  **ZoneMTA** with WildDuck plugin for outbound email
4.  **WildDuck Webmail** for creating accounts and viewing messages
5.  **Nginx** to serve the webmail component
6.  **acme.sh** to manage Let's Encrypt certificates
7.  **Rspamd** to check messages for spam. Messages detected as spam are routed to Junk Mail folder by default
8.  **ClamAV** to check messages for viruses. ClamAV is disabled by default, you need to enable it in the Haraka plugins file
9.  Unprivileged **Deploy** user to easily checkout and publish code changes via git
10. **ufw** firewall to only allow public ports (so make sure your ssh runs on port 22 or otherwise change the install script first)

What it does not configure:

1.  **DNS settings**. These you need to handle yourself. See domainname-nameserver.txt file after installation for DNS configuration (includes DKIM)

## Security

All components use TLS/HTTPS with Let's Encrypt certificates by default. Webmail component allows to set up two factor authentication (both TOTP and U2F). If 2FA is enabled then you can also generate application specific passwords for external applications (eg. for the IMAP client) from the Webmail interface as master password can not be used in that case.

## Usage

Run the following commands as root user. Before actually starting _install.sh_ you could inspect it to see what it exactly does.

> [!IMPORTANT]
> Run the following commands as `root`

```bash
wget -O - https://raw.githubusercontent.com/zone-eu/wildduck/master/setup/get_install.sh | bash
```

```bash
./install.sh mydomain.com mail.mydomain.com
```

Where _mydomain.com_ is the email address domain and _mail.mydomain.com_ is the hostname of current server.

Make sure that used hostname points to current server as the install script tries to fetch an SSL certificate from Let's Encrypt. The MX for email address domain should point to server hostname.

If the installation succeeds then the installer writes DNS configuration to domainname-nameserver.txt file. Set up the provided DNS entries from this file before sending and receiving email.

Next point your browser to https://mydomain.com/ and you should see the WildDuck example webmail app where you can create an email account.

## Config files

Configuration files are installed to the following locations:

1.  WildDuck: /etc/wildduck
2.  ZoneMTA: /etc/zone-mta
3.  WildDuck Webmail: /etc/wildduck/wildduck-webmail.toml
4.  Haraka: /opt/haraka/config

## Log files

All `stdout` and `stderr` is written to service specific log files. For example WildDuck server logs can be found from `/var/log/wildduck-server/wildduck-server.log`.

## Code changes

Install script sets up applications as remote git repositories. You can clone these to your own machine using a special deploy user. If you push changes back to the remote repo, related services are restarted automatically.

```
$ git clone deploy@hostname:/var/opt/wildduck.git
$ cd wildduck
$ git checkout master
$ .... make some changes
$ git add .
$ git commit -m "made some changes"
$ git push origin master -f
```
