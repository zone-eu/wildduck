# API request handling and validation

The HTTP API runs on [Fastify](https://fastify.dev/). Request validation,
response serialization and the OpenAPI specification are all generated from a
single per route declaration, so a route is described once and never validated
by hand inside a handler.

This document describes the contract that route modules in `lib/api/` follow.

## Route declaration

```javascript
server.route({
    method: 'POST',
    url: '/users/:user/mailboxes',
    schema: {
        summary: 'Create Mailbox',
        tags: ['Mailboxes']
    },
    config: {
        name: 'createMailbox',
        validationObjs: {
            pathParams: { user: { $ref: 'wd:userId' } },
            queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
            requestBody: { path: { type: 'string', wdRequired: true } },
            response: {
                200: { description: 'Success', model: { type: 'object', properties: { success: { $ref: 'wd:successRes' } } } }
            }
        }
    },
    async handler(req, reply) {
        return reply.send({ success: true });
    }
});
```

An `onRoute` hook (`lib/fastify/routes.js`) compiles `config.validationObjs`
into a validator, attaches the response models to the route so
fast-json-stringify serializes replies, and derives the OpenAPI parameter and
body documentation. A route is kept out of the specification with the standard
Fastify `schema: { hide: true }`.

Recognized `config` keys:

| key              | meaning                                                      |
| ---------------- | ------------------------------------------------------------ |
| `name`           | route name: OpenAPI `operationId` and the route registry     |
| `validationObjs` | request and response schema declaration                      |
| `allowUnknown`   | accept unknown keys instead of rejecting them                |
| `charset`        | `false` when JSON replies must not carry a charset parameter |
| `preValidate`    | mutate the merged params before validation                   |
| `rawBodyParam`   | map a raw (Buffer or string) body into a named param         |
| `public`         | serve the route without an access token                      |

## The merged params model

Path parameters, the query string and the parsed request body are merged into
one object, and validation runs on that object rather than per request part.
This is deliberate: clients may supply body-declared fields through the query
string. Uploading a message, for example, sends the RFC822 source as the body
while passing `date` and `unseen` as query parameters.

Merge rules, per key:

- path parameters first, then query keys, then body keys
- an existing **truthy** value is never overwritten, a falsy one is
- an array JSON body replaces the params entirely when the route has no path
  parameters, and is an error when it has
- Buffer and raw string bodies are not merged; handlers read `req.body`, or
  declare `rawBodyParam` to receive the payload as a named param

The validated result is exposed to the handler as `req.params`. The
pre-validation view stays available as `req.rawParams`, which matters for
handlers that distinguish "key absent" from "key set to an empty value"
(clearing a field with an empty string, for instance).

Query strings are parsed with [qs](https://www.npmjs.com/package/qs) and
`allowDots`, so `?foo.bar=1` becomes `{ foo: { bar: '1' } }`.

## Validation engine

Validation uses [Ajv](https://ajv.js.org/) with a fixed configuration
(`lib/fastify/validation.js`):

- `allErrors: true`, so a request reports every problem at once
- `coerceTypes: false`. Ajv's own coercion accepts values the API must reject
  (`'0x10'`, `''` and `'Infinity'` as numbers, numbers as strings). All
  coercion is instead done by a pre-pass driven by the `wd*` annotations below.
- `useDefaults: true`, so a `default` keyword fills in missing keys
- `strict: false`, because schemas carry the `wd*` annotations and are shared
  with the OpenAPI generator

Unknown keys are rejected unless the route sets `allowUnknown`.

### Conversion annotations

The annotations are inert for Ajv itself and drive the conversion pre-pass:

| annotation                    | effect                                                                    |
| ----------------------------- | ------------------------------------------------------------------------- |
| `wdType`                      | convert the value: `number`, `boolean`, `booleanStrict`, `date`, `binary` |
| `wdEmpty`                     | treat an empty string as absent, so a `default` applies                   |
| `wdTrim`                      | trim surrounding whitespace                                               |
| `wdLowercase` / `wdUppercase` | case normalization                                                        |
| `wdRequired`                  | the key is required                                                       |
| `wdSingle`                    | wrap a bare scalar into an array                                          |
| `wdSplitCsv`                  | accept a comma separated string in place of an array                      |
| `wdMaxBytes`                  | maximum size of a converted Buffer                                        |
| `wdValidator`                 | run a named custom validator                                              |
| `wdInstanceof`                | assert the pre-pass produced a `Date` or a `Buffer`                       |
| `wdDateGtNow`                 | the date must be in the future                                            |

Conversion semantics worth knowing:

- **numbers** accept decimal and scientific notation with surrounding
  whitespace (`'1e3'`, `' 15.5 '`), and reject `'0x10'`, `''` and `'Infinity'`
- **booleans** accept real booleans, `1`/`0`, and case-insensitive `Y`, `yes`,
  `true`, `on` / `N`, `no`, `false`, `off`
- **dates** accept ISO strings, epoch milliseconds and numeric strings, and
  reach the handler as a real `Date`
- **binary** fields reach the handler as a `Buffer`

Named validators available through `wdValidator`: `mongoCursor`, `metaData`,
`mailboxPath`, `ip`, `email`, `emailFailoverEmpty`, `hostname`, `domain`,
`uri`, `smtpUrl`, `webhookUrl`.

`minLength` and `maxLength` count UTF-16 code units, the same unit
`String.length` reports. A character outside the Basic Multilingual Plane, an
emoji for example, counts as two. This keeps the limits identical to what the
API enforced historically, and it keeps the check constant time: counting
code points instead would scan the whole value, which is measurable on the
fields that allow up to a megabyte.

### Shared schemas

Common types are registered once and referenced with `$ref`: `wd:userId`,
`wd:mailboxId`, `wd:messageId`, `wd:sess`, `wd:ip`, `wd:boolean`,
`wd:pageLimit`, `wd:pageNr`, `wd:cursor`, `wd:metaData`, `wd:username`, and
the response helpers `wd:successRes`, `wd:totalRes`, `wd:pageRes`,
`wd:previousCursorRes`, `wd:nextCursorRes`. The `objectIdSchema()` and
`dateOrFalse()` factories in `lib/schemas/json-schemas.js` cover the two most
common parameter shapes.

Cross-key conditionals (a field required only when another field has a certain
value) are expressed as JSON Schema `if`/`then` fragments in a `conditions`
array on `validationObjs`.

## Response contract

A rejected request answers `400`:

```json
{
    "error": "\"user\" must match pattern \"^[0-9a-f]{24}$\"",
    "code": "InputValidationError",
    "details": { "user": "\"user\" must match pattern \"^[0-9a-f]{24}$\"" }
}
```

Successful responses are `{ "success": true, ... }`. Failures raised by a
handler are `{ "error": "message", "code": "ErrorCode" }`, with the status
taken from the error's `responseCode`. Errors carrying the IMAP codes
`ALREADYEXISTS`, `NONEXISTENT` and `CANNOT` are mapped to
`MailboxExistsError` (400), `NoSuchMailbox` (404) and
`DisallowedMailboxMethod` (400).

Handlers do not catch their own errors: throwing is the documented way to
produce an error response, and the global error handler in
`lib/fastify/bootstrap.js` owns the shape.

> **Response models drop undeclared fields.** Attaching a response model
> activates fast-json-stringify, which silently omits any property the model
> does not declare. A model must describe what the handler actually returns,
> not an idealized version of it. Fields that may hold `null` or values of
> more than one type are declared without a `type`.

`required` in a response model is documentation only. fast-json-stringify
treats it as an assertion and throws when the payload lacks one of the keys,
which would turn a single incomplete database document (a migration, an
external tool, a record predating a field) into a 500 for a whole listing. The
serializer compiler in `lib/fastify/routes.js` therefore strips `required` from
the schema it compiles, while `@fastify/swagger` keeps reading the original, so
the published specification still states which fields a caller can expect.

## Body parsing

| content type                        | handling                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `application/json`, `*+json`        | parsed; an empty body is not an error                                                      |
| `application/x-www-form-urlencoded` | parsed with `qs`                                                                           |
| `application/octet-stream`          | **not** consumed, so a handler can pipe the raw request (`POST /data/import` does)         |
| `multipart/form-data`               | parsed with `@fastify/multipart`: form fields arrive as strings, uploaded files as Buffers |
| `text/*`                            | utf-8 string                                                                               |
| anything else                       | Buffer (`message/rfc822` uploads and similar)                                              |

The body size limit is 1 GB and path parameters are limited to 196 characters.

## Streaming responses

Downloads (attachments, message sources, stored files, audit exports) return
the stream directly with `reply.send(stream)`. Two routes take over the raw
response instead, because they write outside the normal reply lifecycle: the
change stream at `/users/:user/updates`, which is a Server-Sent-Events stream,
and `POST /data/export`, which appends an error trailer after the response has
already started.

Those two go through `server.beginRawResponse(req, reply, status, headers)`.
Hijacking the response means Fastify runs none of the reply hooks, so the
helper applies the header policy and emits the access log line and the request
metric itself when the connection closes.

## Notes for API clients

- JSON responses are compact. They are not pretty-printed and carry no
  trailing newline.
- CORS headers are present on every response, not only on requests that carry
  an `Origin` header.
- A request to a known path with an unsupported method answers `404`
  `ResourceNotFound` rather than `405`.
- Validation error message text is generated by Ajv. The status, the `code`
  and the set of offending field paths in `details` are the stable part of the
  contract; the prose is not.

## Notes for library consumers

Projects that import WildDuck as a library (`@zone-eu/wildduck/lib/*`), such
as the Haraka and ZoneMTA plugins, are unaffected by the HTTP layer with two
exceptions:

- `tools.responseWrapper()` no longer exists. Handler error translation is
  owned by the Fastify error handler, so there is nothing left to wrap.
- The callback of `api.js` yields the Fastify instance rather than a Restify
  server, which matters only if the API server is embedded directly.
