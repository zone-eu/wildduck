# Outbound SMTP

Use [WildDuck MTA](https://github.com/nodemailer/wildduck-mta) (which under the hood is [ZoneMTA](https://github.com/zone-eu/zone-mta) with the
[ZoneMTA-WildDuck](https://github.com/zone-eu/zonemta-wildduck) plugin).

This gives you an outbound SMTP server that uses WildDuck accounts for authentication. The plugin authenticates user credentials and also rewrites headers if
needed (if the header From: address does not match user address or aliases then it is rewritten).