# Pinned validation semantics: Restify+Joi baseline (fastify-migration)

Everything below was determined empirically from restify 11.1.0 source, Joi 18 probes,
and the wildduck route code on 2026-07-30. The Fastify adapter must reproduce these
behaviors exactly.

## 1. Request param assembly (restify mapParams)

Middleware order: router path params populate `req.params` first, then
`queryParser({allowDots: true, mapParams: true})`, then
`bodyParser({maxBodySize: 0, mapParams: true, mapFiles: true, overrideParams: false})`.

Merge rules (from restify source, per key `k`):
- queryParser: `if (req.params[k] && !overrideParams) skip; else req.params[k] = query[k]`
- jsonBodyParser: same pattern against the params object that already contains path+query.
- So precedence is path > query > body, BUT the existing-value check is TRUTHINESS,
  not presence: a falsy path/query value ('' or '0'->parsed falsy etc.) IS overridden
  by a later source.
- Query parsing uses `qs` with allowDots: true (`?foo.bar=1` -> `{foo:{bar:'1'}}`),
  arrayLimit default 20, `?a=1&a=2` -> array.
- JSON body that is an array: stomps req.params entirely if no path params, else 500.
  Non-object JSON body (string/number): stomps req.params entirely.
- restify's bodyReader SKIPS `application/octet-stream` and `multipart/form-data`
  entirely: the request stream stays unconsumed and `req.body` is undefined, so
  handlers can pipe the raw request themselves (POST /data/import relies on it).
- Other non-text content types (message/rfc822) are read into `req.body` as a
  Buffer (no params mapping). Text-ish types (application/json, form, text/*)
  become utf8 strings before parsing.
  Handlers in messages.js:2433 and storage.js:63 manually copy `req.body` into
  `req.params.raw` / `req.params.content` when the param is not already set.

## 2. Validation call (per route, boilerplate to be centralized)

`Joi.object({...pathParams, ...requestBody, ...queryParams}).validate(req.params, opts)`

- Validation runs on the MERGED object. This is load-bearing: clients legally supply
  requestBody-declared fields via querystring (message upload: ?date=...&unseen=true
  with an rfc822 body; prepare.sh relies on it). Per-part Fastify validation would
  reject these, so the adapter validates the merged object and Fastify's native
  per-part request validation is disabled (schemas still attached for docs and for
  response serialization).
- Options: `{abortEarly: false, convert: true}` on most routes -> unknown keys are
  REJECTED (`"x" is not allowed`). A subset of routes adds `allowUnknown: true`
  (acme, and specific routes in addresses, certs, dkim, domainaliases, filters,
  messages x4, settings, storage, submit, users, webhooks); auth has explicit
  `allowUnknown: false` on some routes. The adapter takes a per-route allowUnknown
  flag mapping to additionalProperties handling. Never assume; read each route's
  current validate call during conversion.
- abortEarly: false -> collect all errors (Ajv allErrors: true).

## 3. 400 error contract (InputValidationError)

```
status 400
{
  "error": "<result.error.message>",        // Joi joins messages with '. '
  "code": "InputValidationError",
  "details": { "<detail.path>": "<detail.message>", ... }   // first message per path
}
```
Message TEXT will differ from Joi under Ajv (accepted per goal); shape and paths must hold.

## 4. Joi conversion rules (convert: true) that Ajv must replicate

Verified by probe. Ajv's built-in coerceTypes does NOT match (it accepts '0x10', '',
'Infinity' for numbers via +data, and casts numbers to strings). Therefore:
**coerceTypes: false**; all coercion via custom modifying keywords replicating Joi:

- number: trim whitespace; accept decimal/scientific ('1e3', '+15', '15.5');
  REJECT '0x10', '', 'Infinity', non-numeric. integer() additionally rejects
  non-integers (15.5). Existing numbers pass; non-string non-number rejected.
- boolean (lib/schemas.js booleanSchema): real booleans pass; strings matched
  CASE-INSENSITIVELY against truthy ['Y','true','yes','on','1'] / falsy
  ['N','false','no','off','0']; numbers 1/0 accepted; '' -> undefined (empty(''))
  which then triggers defaults; anything else rejected.
- string: numbers are NOT cast to strings (real 15 fails a string field even in
  query context because qs always yields strings anyway). trim()/lowercase()
  transforms apply where declared.
- date: Joi.date() accepts ISO strings, epoch-ms numbers AND numeric strings
  ('1700000000000'); output is a real Date instance handed to handlers (sendTime
  etc.), so the keyword must replace the value with a Date.
- binary: Joi.binary() converts strings to Buffers (utf8); Buffers pass through.
- empty(''): empty string treated as undefined, then .default() applies.
- .default(x): applied for missing/undefined keys (Ajv useDefaults can cover pure
  JSON defaults; keywords handle post-empty defaults).

## 5. Joi features needing custom Ajv keywords/formats

- sessIPSchema: IP v4 or v6, CIDR forbidden (ajv-formats ipv4/ipv6 in anyOf).
- mongoCursorSchema: trim, empty(''), max 1024, charset [a-zA-Z0-9\-_], must
  base64url-decode into parseable EJSON (custom keyword calling
  mongodb-extended-json, exactly as lib/schemas.js mongoCursorValidator).
- metaDataSchema: object OR JSON string; if object -> JSON.stringify; string form
  trimmed, max 1MB, must JSON.parse to an object; normalized value is the STRING.
- usernameSchema: lowercase transform then regex
  /^[a-z0-9-]+(?:[._=:][a-z0-9-]+)*(?:@[a-z0-9-]+(?:[._=:][a-z0-9-]+)*)?$/, 1..128.
- mailboxPathValidator (mailboxes.js x2): path depth <= MAX_SUB_MAILBOXES, each
  segment <= MAX_MAILBOX_NAME_LENGTH.
- messages.js:1109 custom validator (inspect during messages module conversion).
- .when() conditionals: certs.js x2, auth.js:146, settings.js:119 -> JSON Schema
  if/then/else or custom keyword per case.
- ObjectId-style IDs: Joi.string().hex().lowercase().length(24) (userId etc.) ->
  pattern ^[0-9a-f]{24}$ with lowercase transform first.

## 6. Response serialization

Response schemas activate fast-json-stringify which drops undeclared fields.
Existing response models are doc-oriented and possibly incomplete; every route must
be diffed against golden responses after attaching its response schema. Any dropped
field = schema bug to fix.

## 7. Other behaviors to preserve

- JSON output: restify formatter used `JSON.stringify(body, false, 2) + '\n'`
  (pretty-printed, trailing newline) and doubled as the Gelf logging hook.
  Decide: keep pretty output for byte-parity (golden headers include
  Content-Length) via custom serializer; Gelf hook moves to onSend/onResponse.
- res.charSet('utf-8') -> Content-Type: application/json; charset=utf-8.
- accessToken is stripped from query/params/headers by the auth middleware BEFORE
  validation (otherwise unknown-key rejection would fire).
- Streaming responses (attachments, exports, audits) bypass serialization; SSE
  route /users/:user/updates migrates last.
- Static /public, /metrics route (excludeRoute: true, skipped from docs), ACME
  routes named 'acmeToken' skip the token check.
- strictRouting: true (trailing slashes significant), maxParamLength 196.

## 8. Documented deviations of the Fastify implementation

Accepted, deliberate differences from the restify behavior. Everything not
listed here is expected to match the goldens exactly.

- JSON bodies are compact, not pretty-printed with a trailing newline
  (whitespace only; semantic content identical; Content-Length differs
  accordingly).
- The `vary` header is managed by @fastify/cors and differs from
  restify-cors-middleware2's fixed
  `origin,access-control-request-method,access-control-request-headers` chain.
- @fastify/cors sends `access-control-allow-origin` (and credentials headers)
  on every response; restify-cors-middleware2 only added them when the request
  carried an Origin header. CORS semantics are equivalent or more permissive
  for browser clients.
- Validation error message TEXT will change when modules move from Joi to Ajv
  (400 shape {error, code, details} is preserved; per goal, no Joi message
  emulation).
- multipart/form-data is no longer parsed by formidable into params/files.
  restify had mapFiles enabled but no route or test uses multipart; the raw
  stream is left unconsumed like octet-stream.
- 405 Method Not Allowed responses become 404 ResourceNotFound (no route or
  test exercises 405).
- `npm run generate-api-docs` (restifyapigenerate) is broken between the
  bootstrap commit and the @fastify/swagger switch at the end of the
  migration.
- The /api-methods test-only route dumps the adapter route registry instead of
  restify's router.getRoutes() internals (same essential fields: name, method,
  path, spec).
- GET message with replaceCidLinks=true now produces real attachment URLs.
  The restify code called server.router.render('attachment', ...) but the
  route is named getMessageAttachment, so render() returned null and every
  cid link was replaced with the literal string "null". The adapter's render()
  is called with the correct route name and restores the documented intent.
- The convert pre-pass applies anyOf/oneOf branch transforms even when that
  branch does not end up matching, so mixed-case EMAIL usernames on
  /preauth and /authenticate reach the handler lowercased (the wd:username
  branch's lowercase transform fires before the email branch matches). Joi
  alternatives kept the original casing. Behaviorally inert: authentication
  normalizes addresses through tools.normalizeAddress anyway; the difference
  is only visible in authlog echoes.
