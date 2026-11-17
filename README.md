# WildDuck Mail Server

<p align="center">
  <a href="https://wildduck.email" target="blank"><img src="./graphics/wildduck-type.svg" width="256" alt="Wild Duck" /></a>
  <br />
  WildDuck is a scalable no-SPOF IMAP/POP3 mail server.
</p>

<p align="center">
  <a href="https://gitter.im/nodemailer/wildduck" target="_blank"><img src="https://img.shields.io/gitter/room/nodemailer/wildduck?color=orange" alt="gitter" /></a>
  <a href="https://raw.githubusercontent.com/nodemailer/wildduck/refs/heads/master/docs/api/openapidocs.json"><img src="https://img.shields.io/swagger/valid/3.0?specUrl=https%3A%2F%2Fraw.githubusercontent.com%2Fnodemailer%2Fwildduck%2Frefs%2Fheads%2Fmaster%2Fdocs%2Fapi%2Fopenapidocs.json"></a>
  <a href="https://github.com/zone-eu/wildduck/blob/master/LICENSE" target="_blank">
    <img src="https://img.shields.io/github/license/zone-eu/wildduck" alt="License" />
  </a>
</p>

WildDuck uses a distributed database (sharded + replicated MongoDB) as a backend for storing all data, including emails.

WildDuck tries to follow Gmail in product design. If there's a decision to be made then usually the answer is to do whatever Gmail has done.

## Protocols

- **IMAP4rev1** with IDLE, CONDSTORE, MOVE, UTF8=ACCEPT, OBJECTID and other extensions
- **POP3**
- **JMAP** for mail, contacts and calendars ([RFC 8620](https://www.rfc-editor.org/rfc/rfc8620), [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621), [RFC 9610](https://www.rfc-editor.org/rfc/rfc9610), the calendars draft without scheduling), disabled by default. See [JMAP service](docs/in-depth/jmap.md)
- **REST API** for management and webmail clients

See [protocol support](docs/in-depth/protocol-support.md) for the full list of extensions and known differences.

## Links

- [Website](https://wildduck.email)
- [Documentation](https://docs.wildduck.email)
- [Installation instructions](https://docs.wildduck.email/docs/general/install)
- [API Documentation](https://docs.wildduck.email/docs/category/wildduck-api)

## License

WildDuck Mail Server is licensed under the [European Union Public License 1.2](https://joinup.ec.europa.eu/collection/eupl/eupl-text-eupl-12) or later.

> WildDuck Mail Server is part of the Zone Mail Suite (ZMS). Suite of programs and modules for an efficient, fast and modern email server.

Copyright (c) 2024 Zone Media OÜ
