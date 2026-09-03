# Read-only MCP service

WildDuck can expose mailbox and message data to Model Context Protocol clients through an independent, read-only Streamable HTTP service.

The service does not read MongoDB directly. Every tool call becomes an ordinary request to the WildDuck REST API, carrying the caller's own token, so the same Joi validation, the same `roles.can(req.role)` checks, the same response schemas and the same audit trail apply as they would to any other API client. There is deliberately no second read path that could drift from the one the API serves.

The service is disabled by default. A minimal loopback configuration is:

```toml
[mcp]
enabled = true
host = "127.0.0.1"
port = 8082
path = "/mcp"
secure = false
apiUrl = "http://127.0.0.1:8080"
allowedHosts = ["127.0.0.1", "localhost", "[::1]"]
allowedOrigins = ["http://127.0.0.1:8082", "http://localhost:8082"]
maxRequestSize = 1048576
maxResults = 50
maxBodyChars = 50000
```

`apiUrl` points at the internal API and must not be a public address. Leave it unset to follow the `[api]` configuration, so moving the API port cannot leave MCP pointed at whatever answers on the old one. `allowedHosts` contains hostnames without ports and protects the listener from DNS-rebinding requests; behind a reverse proxy it must list the public hostname, because the `Host` header is whatever the proxy sets. `allowedOrigins` contains exact browser `Origin` values. Command-line clients normally send no Origin header and remain valid.

`maxRequestSize` applies to every method that carries a body.

Set `trustProxy = true` only when the listener sits behind a reverse proxy that sets `X-Forwarded-For`. While it is false the socket address is used, so a caller cannot spend or dodge a rate limit by setting a header. While it is true the last entry of the header is used, not the first: a proxy appends the address it saw to whatever the client sent, so everything before the final entry is client-supplied text. The setting therefore describes one trusted hop; behind two chained proxies the address resolves to the inner one, which shares a rate limit budget rather than dodging it.

Only the configured path is served. WildDuck accepts `POST`, `GET` and `DELETE` plus CORS preflight requests; everything else answers 404. The stateless transport does not require sticky sessions when WildDuck runs with multiple workers.

## Deploying behind a public interface

The WildDuck API is not meant to be public. Where MCP has to be, publish it by proxying the single MCP path from a public interface, such as a webmail host, to this service:

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:8082/mcp;
}
```

Use an exact path match rather than a prefix, and proxy to this service rather than to the API. The MCP service implements a handful of read tools and nothing else, so a path-normalization mistake in the proxy cannot reach an API route.

## TLS

The loopback and plaintext defaults are intended for local clients or a trusted TLS-terminating reverse proxy. Do not publish the listener over plaintext on an untrusted network.

MCP uses the same certificate loading, SNI/ACME lookup, and certificate reload mechanism as the other WildDuck listeners:

```toml
[mcp]
enabled = true
host = "0.0.0.0"
port = 8443
secure = true
allowedHosts = ["mail.example.com"]

[mcp.tls]
key = "/path/to/server/key.pem"
cert = "/path/to/server/cert.pem"
```

If MCP-specific certificate paths are omitted, WildDuck falls back to the global TLS certificate and then the bundled self-signed certificate. The MCP service can be the only enabled client service: `api.enabled = false` does not prevent MCP from starting, though the API must still be reachable at `apiUrl` for tools to work.

## Tokens

MCP accepts only dedicated personal access tokens beginning with `wdmcp_`. API access tokens, root tokens, application-specific passwords, query-string tokens and `X-Access-Token` headers are rejected. Send the token as an HTTP bearer credential:

```text
Authorization: Bearer wdmcp_1...
```

### Format

A token is 79 characters: the `wdmcp_` prefix, a format version digit, 32 random bytes as lowercase hex, and a CRC32 checksum over the version and secret.

```text
wdmcp_ 1 3f9a71c4e2b85d06a147fc39e0d2b6581aa4c7e93b05f2d81c6e4a70b93df215 9838c218
prefix v ── secret ─────────────────────────────────────────────────────  checksum
```

Nothing in the string is readable: it carries no claims, no signature and nothing about the user or the grant. Only a SHA-256 digest is stored, so a database dump yields no usable credentials, and revocation takes effect on the next request.

The checksum is not a security control. It is public and recomputable, and anyone can produce a well-formed value that fails the lookup. It exists so a truncated paste fails in the client rather than an hour later, so secret scanners get fewer false positives, and so malformed credentials are refused before spending a database round trip. Validate it wherever a person can type a token:

```js
const { crc32 } = require('zlib');
const match = token.match(/^wdmcp_(\d)([a-f0-9]{64})([a-f0-9]{8})$/);
const valid =
    match &&
    crc32(match[1] + match[2])
        .toString(16)
        .padStart(8, '0') === match[3];
```

### Managing tokens

Create a token from the command line without running either HTTP listener:

```bash
node bin/mcp-tokens create alice@example.com --description "Codex"
node bin/mcp-tokens list alice@example.com
node bin/mcp-tokens revoke alice@example.com 64f000000000000000000001
```

`create` accepts a user ID, username or email address. Tokens do not expire by default; add a fixed future ISO timestamp when needed:

```bash
node bin/mcp-tokens create alice --description "Temporary client" --expires "2027-01-01T00:00:00Z"
```

The REST endpoints are:

- `POST /users/:user/mcp-tokens`
- `GET /users/:user/mcp-tokens`
- `DELETE /users/:user/mcp-tokens/:token`

The create command and `POST` return the plaintext token once. Save it immediately; later list responses contain metadata only. Revocation takes the record ID, not the token value.

Users may manage their own tokens. Root, manager and webmail roles may manage tokens for any user. The `mcp:read` role itself has no grant here, so an MCP token can never mint another MCP token.

Password or authentication-version changes invalidate every existing token, and disabled, suspended or expired accounts cannot authenticate. Suspending an account raises its authentication version and releasing it does not lower it again, so a suspension permanently retires the tokens issued before it and the user has to mint new ones. A token that appears in the listing may therefore already be dead; the listing records what was issued, not what still works. A user can also be denied the service entirely by adding `mcp` to their `disabledScopes`, and deleting a user deletes their tokens immediately rather than at the end of the deletion grace period.

One user may hold up to `MAX_MCP_TOKEN_COUNT` tokens. Minting and revoking are recorded in the user's own `authlog` as `create mcp token` and `delete mcp token`, and published as the `mcptoken.created` and `mcptoken.deleted` webhook events.

### Access level

Every token stores an access level, resolved into `req.role` when it authenticates. Only `mcp:read` exists today, granting read access to that user's own account, addresses, mailboxes and messages, and nothing else. The level is defined in `config/roles.json` like every other role, including the field allowlist, so what an agent may see is declared in one place. The allowlist is applied by the API on the way out, not only by the MCP service, so the credential is bounded by it whatever client presents it.

## Client configuration

For Codex, keep the token in an environment variable and add this to `~/.codex/config.toml`:

```toml
[mcp_servers.wildduck]
url = "https://mail.example.com/mcp"
bearer_token_env_var = "WILDDUCK_MCP_TOKEN"
```

Claude Code can use an environment-expanded configuration:

```json
{
    "mcpServers": {
        "wildduck": {
            "type": "http",
            "url": "https://mail.example.com/mcp",
            "headers": { "Authorization": "Bearer ${WILDDUCK_MCP_TOKEN}" }
        }
    }
}
```

Avoid putting the plaintext token in a tracked configuration file or in shell history.

## Available tools

| Tool               | Result                                                       |
| ------------------ | ------------------------------------------------------------ |
| `get_account`      | Account profile, primary address, aliases and quota usage    |
| `list_mailboxes`   | Mailbox paths, optional hidden mailboxes, counters and sizes |
| `list_messages`    | Paged message summaries for one exact mailbox path or ID     |
| `search_messages`  | Paged message summaries from typed filters                   |
| `get_message`      | Envelope data, flags, attachment metadata and a bounded body |
| `get_message_text` | A further window of one message body                         |

A token is only shown the tools its access level can call, so an agent never plans around a call that would answer 403. Every tool is annotated read-only.

List and search default to 20 results, or to `maxResults` when that is lower, and never return more than `MCP_MAX_RESULTS`. `search_messages` takes read state as a boolean, where false means read rather than unfiltered; the filters the REST search route has no negative form for, `has_attachments`, `flagged` and `searchable`, accept only `true`, so an argument that would silently match every message is refused rather than ignored. Bodies are capped at `MCP_MAX_BODY_CHARS`; a capped body reports `hasMore`, and `get_message_text` reads on from an offset. HTML is returned only when `body_format` is `html` or `both`, and it is sanitized through an allowlist: only structural and text markup survives, only a few attributes on it, and only the `http`, `https`, `mailto` and `cid` schemes in those attributes. Scripts, event handlers, styling, forms, media elements and foreign parsing contexts such as `svg` and `math` are removed outright, and an image keeps a source only when it names a `cid:` attachment of the same message. Relative and protocol-relative references count as remote, since the consumer resolves them against its own base.

The effect is that reading a message cannot execute anything and cannot tell the sender it was opened. This is about the result being inert data; it does nothing about prompt injection, which no sanitizer can fix.

Arguments are strict. No tool accepts a user or account argument, because the token is the binding; an argument the schema does not declare is refused rather than quietly dropped.

MCP reads do not mark messages as seen and do not update flags, counters, modification indexes or notification streams. That is a property of the credential rather than of the client: the API refuses `markAsSeen` from a level that holds no write grant, so a token cannot change message state even through the routes its tools use. The service does not expose raw EML, arbitrary headers or metadata, attachment content, forwarding targets, draft storage references, outbound queue state, BIMI images, resources, prompts or write tools.

Mail content is untrusted data. The server instructions tell clients not to follow links, fetch URLs, execute commands, disclose secrets or interpret instructions found in messages. This is a mitigation and not a control: the words in a message are attacker-controlled, and read-only access is what bounds the damage.

## Limits

| Limit                              | Constant                                | Default     |
| ---------------------------------- | --------------------------------------- | ----------- |
| Failed authentications per address | `MCP_AUTH_FAILURES` / `MCP_AUTH_WINDOW` | 30 per 120s |
| Tool calls per token               | `MCP_TOOL_CALLS` / `MCP_TOOL_WINDOW`    | 600 per 60s |
| List and search page size          | `MCP_MAX_RESULTS`                       | 50          |
| Body characters per call           | `MCP_MAX_BODY_CHARS`                    | 50000       |
| Tokens per user                    | `MAX_MCP_TOKEN_COUNT`                   | 50          |

Only failed authentications are counted, so a working client never approaches that limit.

## Operations

Prometheus includes MCP service state, authentication results, bounded HTTP and tool duration metrics, result counts and result-size histograms.

Authentication is recorded in the user's own `authlog`, readable at `GET /users/:user/authlog`, with `protocol` set to `MCP`. Tool call logs contain only the token record ID, user ID, tool name, status, duration and result size. Bearer secrets, tool arguments, search terms, headers and message content are never logged.
