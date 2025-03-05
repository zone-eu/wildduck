# Migration guide

**Remark**: This guide may contain factual errors, so please doublecheck everything, and correct this wiki page.

This is a recollection of migrating from Microsoft Exchange server to wildduck.

## Install wildduck

This is rather straightforward. Install it via the [builtin setup script][0].
The best is on a server or virtual server (I installed inside a kvm virtual server).

## Check your email server

There [are][1] some [useful][2] website to [check][3] if your email server working correctly.
You may need to remove yourself from some [spam site][4].

## Domain settings

### SPF

You need to add a TXT record into DNS:
v=spf1 a:yourdomain.com ~all

### DKIM

Also DKIM settings.

```
jun2018._domainkey .yourdomain.com
v=DKIM1;p=MIIBIjANBgkqhkiG9...
```

### Certification (for wildduck-webmail)

```
HOSTNAME="mail.yourdomain.com"
/root/.acme.sh/acme.sh --issue --nginx --server letsencrypt \
    -d "$HOSTNAME" \
    --key-file       /etc/wildduck/certs/privkey.pem  \
    --fullchain-file /etc/wildduck/certs/fullchain.pem \
    --reloadcmd     "/usr/local/bin/reload-services.sh" \
--force || echo "Warning: Failed to generate certificates, using self-signed certs"
```

## Recheck the wildduck settings

```
/etc/zone-mta/plugins/wildduck.toml
hostname="yourdomain.com"
->
hostname="mail.yourdomain.com"
```

## Outlook client settings

(Wildduck server is on your local network)

```
name: Anon Imous
email address: anon@yourdomain.com

Server details
account type: IMAP
Incoming messages server: 192.168.0.1
Outgoing messages server: 192.168.0.1
Login details
username: anon
password: ftxgXXXXYYYYlhkf (generated via wildduck webmail, application specific password)
[x] password storage
[ ] Secure password ... login

[Advanced settings] ->
[Outgoing emails server]
[x] Outgoing server (SMTP) requires authentication
[x] Same settings with incoming email server

[Special]
Incoming server (IMAP): 993
The following secure connection type: SSL
Outgoing server (SMTP): 587
The following secure connection type: TLS
```

## Add users to wildduck

The easiest with wildduck-webmail.

## Migrate emails from old system (outlook clients)

The best method was to convert the outlook's .pst file to maildir format:

(I did the conversion inside a separate virtual machine (docker container)).

```
sudo apt-get install pst-utils
sudo apt-get install isync
mkdir anon_maildir; cd anon_maildir
readpst -M anon_inbox.pst
```

### Migrate maildir to WildDuck

There are multiple ways to import maildir into WildDuck

#### 1. import-maildir tool

You can use [import-maildir](https://github.com/nodemailer/import-maildir) tool to import maildir files straight to WildDuck database. You would need to have access to WildDuck database servers and the tool is tested on Courier based maildir folders, so it might not handle all extra additions of Dovecot maildir.

```
$ git clone git://github.com/nodemailer/import-maildir.git
$ cd import-maildir
$ npm install --production
```

Next edit config/default.toml and set correct MongoDB and Redis settings. There are other tunable properties as well but these could be left as is.

```
$ nano config/default.toml
```

Once everything is set up you can start the importer

```
$ ./bin/import-maildir userid:maildirpath
```

Where

-   **userid** is either user id (24byte hex), username or an email address of the user to be imported (the user account must already exists in WildDuck)
-   **maildirpath** is the maildir folder location of that user

```
$ ./bin/import-maildir user@example.com:/var/mail/user_example.com/
```

If you want to import multiple users, then you can do so with a single command

```
$ ./bin/import-maildir user1@example.com:/var/mail/user1_example.com/ user2@example.com:/var/mail/user2_example.com/ user3@example.com:/var/mail/user3_example.com/
```

> In case of multiple users you might want to edit `uploaders` value to something greater than 1. This would allow to import users in parallel.

#### 2. mbsync tool

mbsync is a proven tool but to use it you need to know the passwords of IMAP users. Additionally it is much slower than import-maildir as there is IMAP overhead.

Sync emails (in maildir format) to wildduck:

```
$ cat ~/.mbsyncrc
IMAPAccount yourdomain
# Address to connect to
Host 192.168.0.1
User anon@yourdomain.com
Pass gbxiccfdfbqb
# To store the password in an encrypted file use PassCmd instead of Pass
# PassCmd "gpg2 -q --for-your-eyes-only --no-tty -d ~/.mailpass.gpg"
#
# Use SSL
SSLType IMAPS
# The following line should work. If get certificate errors, uncomment the two following lines and read the "Troubleshooting" section.
CertificateFile /pst/19216801.cert
#CertificateFile ~/.cert/imap.gmail.com.pem
#CertificateFile ~/.cert/Equifax_Secure_CA.pem

IMAPStore yourdomain-remote
Account yourdomain

MaildirStore yourdomain-local
Subfolders Verbatim
# The trailing "/" is important
Path /pst/maildir-anon/
Inbox /pst/maildir-anon/Inbox

Channel yourdomain
Master :yourdomain-remote:
Slave :yourdomain-local:
# Exclude everything under the internal [Gmail] folder, except the interesting folders
#Patterns * ![Gmail]* "[Gmail]/Sent Mail" "[Gmail]/Starred" "[Gmail]/All Mail"
# Or include everything
Patterns *
# Automatically create missing mailboxes, both locally and on the server
Create Both
# Save the synchronization state files in the relevant directory
SyncState *

```

Sync it:
`mbsync -a`

[0]: https://github.com/zone-eu/wildduck/blob/master/setup/README.md
[1]: https://toolbox.googleapps.com/apps/checkmx/check?domain=yourserver.com&dkim_selector=
[2]: https://www.mail-tester.com/
[3]: http://www.appmaildev.com/en/dkim/
[4]: http://www.barracudacentral.org/rbl/removal-request/
