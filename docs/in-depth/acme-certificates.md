# ACME Certificates

WildDuck is able to manage SNI certificates with Let's Encrypt or any other ACME compatible certificate authority.

Requirements to use auto-renewing SNI certificates:

-   SNI certificates are used by IMAP, POP3, WildDuck API, and SMTP servers. MX and Webmail servers are not covered by this.
-   Each server that a SNI hostname resolves to must have either WildDuck API or [ACME agent](https://github.com/zone-eu/wildduck/blob/b46293aba8a112842431336f9c62557b6c66d971/config/acme.toml#L23) running on port 80
-   When using SNI you still have to set up some default certificates in the config file. These could be self-signed though as WildDuck prefers SNI certs whenever possible
-   You must register ACME SNI certificates via [/certs](https://docs.wildduck.email/api/#operation/updateTLSCertificate) API endpoint with the following configuration:

```js
curl -XPOST http://localhost:8080/certs -H 'content-type:application/json' -d'{
    "servername": "imap.example.com",
    "acme": true
}'
```

> The example above expects WildDuck ACME agent running on port 80 in every IP address that _imap.example.com_ resolves to
