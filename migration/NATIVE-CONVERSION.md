# Native Fastify conversion rules for lib/api route modules

Converts a module from the Restify-compat adapter form to native Fastify
routes. The pilot commit (autoreply/health/domainaccess) is the reference;
diff those files if anything below is unclear. lib/fastify/routes.js
documents the runtime that makes this work.

## Route registration

Old form:

```js
server.get(
    {
        path: '/users/:user/thing',
        tags: ['Things'],
        summary: 'Get thing',
        name: 'getThing',
        description: '...',            // optional
        allowUnknown: true,            // optional
        charset: false,                // optional
        rawBodyParam: 'content',       // optional
        preValidate: (params, req) => {...},   // optional
        responseType: 'text/event-stream',     // optional
        excludeRoute: true,            // optional
        validationObjs: { requestBody: {...}, queryParams: {...}, pathParams: {...}, conditions: [...], response: {...} }
    },
    tools.responseWrapper(async (req, res) => { ... })
);
```

New form:

```js
server.route({
    method: 'GET',                     // server.del -> method: 'DELETE'
    url: '/users/:user/thing',
    schema: {
        summary: 'Get thing',
        description: '...',            // only if the old spec had one
        tags: ['Things']
    },
    config: {
        name: 'getThing',
        // allowUnknown / charset / rawBodyParam / preValidate /
        // responseType / excludeRoute move here unchanged, keep only the
        // keys the old spec actually had
        validationObjs: { ... }        // UNCHANGED, byte for byte
    },
    async handler(req, reply) { ... }
});
```

Keep route order, all comments, and the validationObjs content exactly as
they are. Only the registration wrapper and the handler res calls change.

## Handler body conversion

- `tools.responseWrapper(async (req, res) => {` -> `async handler(req, reply) {`
  (drop the wrapper; thrown errors are handled by the global error handler
  with identical behavior). If `tools` was imported ONLY for responseWrapper,
  drop the import; keep it when other tools.* helpers are used.
- `res.json(x)` -> `reply.send(x)`; `return res.json(x)` -> `return reply.send(x)`.
  A bare `res.json(x)` as the final statement also becomes `return reply.send(x)`.
- `res.status(NNN); return res.json(x);` -> `return reply.code(NNN).send(x);`
- `res.status(NNN)` followed by later send in another branch: `reply.code(NNN)`.
- `res.charSet('utf-8');` -> DELETE the line (content-type policy is global now).
- `res.setHeader(k, v)` -> `reply.header(k, v)`.
- `req.params`, `req.rawParams`, `req.query`, `req.body`, `req.headers`,
  `req.user`, `req.role`, `req.accessToken`, `req.validate(...)`: UNCHANGED
  (native decorations provide the same surface; req.params is the validated
  merged params object exactly as before).
- `req.header('X-Foo')` -> `req.headers['x-foo']` (lowercase the name).
- `req.connection` / `req.socket` -> `req.raw.socket`.
- `req.pipe(...)` / `req.once(...)` / `req.on(...)` (raw request stream
  consumers) -> `req.raw.pipe(...)` etc.
- `const result = { value: req.params };` boilerplate lines stay as they are
  (they are inert; do not refactor handler internals beyond the rules here).

## Streaming responses (audit export, storage getFile, message raw/attachment, user export)

`res` was a Writable facade that hijacked the reply on first
writeHead/write/pipe. Native replacement:

```js
res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
stream.pipe(res);
```

becomes

```js
reply.header('content-type', 'application/octet-stream');
return reply.send(stream);
```

- `res.setHeader(...)` before the pipe -> `reply.header(...)`.
- If the old code set an explicit status via writeHead -> `reply.code(...)`.
- Error paths BEFORE the pipe keep the JSON form (`return reply.code(404).send({...})`).
- Multi-stream/manual-write cases (SSE, concatenated streams) instead use
  `reply.hijack()` and write to `reply.raw` directly; CORS/accumulated
  headers must be copied to the raw response first:

```js
reply.hijack();
const headers = Object.assign({ 'Content-Type': 'text/event-stream' }, reply.getHeaders());
reply.raw.writeHead(200, headers);
reply.raw.write(...); reply.raw.end();
```

Flag any handler that does not fit these shapes instead of improvising.

## Verification (run from repo root)

```
./node_modules/.bin/eslint lib/api/<module>.js
node migration/introspect-routes.js | tail -1        # total must stay 119
```

Full capture + golden diff runs once per batch, not per module.
