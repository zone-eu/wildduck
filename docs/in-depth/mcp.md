# Read-only MCP service

WildDuck can expose mailbox and message data to Model Context Protocol clients through an independent, read-only Streamable HTTP service. The MCP listener reads MongoDB and Redis through the same in-process handlers as the REST API; it does not call the API over HTTP and does not require `api.enabled`.

The service is disabled by default. A minimal loopback configuration is:

```toml
[mcp]
enabled = true
host = "127.0.0.1"
port = 8082
path = "/mcp"
secure = false
allowedHosts = ["127.0.0.1", "localhost", "[::1]"]
allowedOrigins = ["http://127.0.0.1:8082", "http://localhost:8082"]
maxRequestSize = 1048576
maxResults = 50
maxBodyChars = 50000
```

`allowedHosts` contains hostnames without ports and protects the listener from DNS-rebinding requests. Add the public hostname when publishing MCP through a reverse proxy. `allowedOrigins` contains exact browser Origin values. Command-line clients normally send no Origin header and remain valid.

Only the configured MCP path is exposed. WildDuck accepts `POST`, `GET`, and `DELETE` methods used by Streamable HTTP, plus CORS preflight requests. The stateless transport does not require sticky sessions when WildDuck runs with multiple workers.

## TLS and public deployments

The loopback and plaintext defaults are intended for local clients or a trusted TLS-terminating reverse proxy. Do not publish the listener over plaintext on an untrusted network.

MCP uses the same certificate loading, SNI/ACME lookup, and certificate reload mechanism as the other WildDuck listeners. To terminate TLS in WildDuck, enable `secure` and optionally configure a service-specific certificate:

```toml
[mcp]
enabled = true
host = "0.0.0.0"
port = 8443
path = "/mcp"
secure = true
allowedHosts = ["mail.example.com"]
allowedOrigins = ["https://client.example.com"]

[mcp.tls]
key = "/path/to/server/key.pem"
cert = "/path/to/server/cert.pem"
ca = ["/path/to/server/ca.pem"]
```

If MCP-specific certificate paths are omitted, WildDuck falls back to the global TLS certificate and then the bundled self-signed certificate. A configuration reload updates the listener certificate for new connections.

The MCP service can be the only enabled client service. For example, `api.enabled = false` does not prevent MCP from starting. Disable the other listeners separately when building an MCP-only deployment.

## Personal access tokens

MCP accepts only dedicated personal access tokens beginning with `wdmcp_`. API access tokens, root tokens, application-specific passwords, query-string tokens, and `X-Access-Token` headers are rejected. Send the token as an HTTP bearer credential:

```text
Authorization: Bearer wdmcp_...
```

Create a token directly from the command line without running either HTTP listener:

```bash
node bin/mcp-tokens create alice@example.com --description "Codex"
node bin/mcp-tokens list alice@example.com
node bin/mcp-tokens revoke alice@example.com 64f000000000000000000001
```

`create` accepts a user ID, username, or email address. Tokens do not expire by default. Add a fixed future ISO timestamp when needed:

```bash
node bin/mcp-tokens create alice --description "Temporary client" --expires "2027-01-01T00:00:00Z"
```

The create command and `POST /users/:user/mcp-tokens` return the plaintext token once. Save it immediately in a secret manager; subsequent list responses contain metadata only. WildDuck stores a SHA-256 token hash, not the bearer secret.

The REST management endpoints are:

- `POST /users/:user/mcp-tokens`
- `GET /users/:user/mcp-tokens`
- `DELETE /users/:user/mcp-tokens/:token`

Users may manage their own tokens. Root, manager, and webmail roles may manage tokens for any user. Revocation applies to the next request. Password or authentication-version changes also invalidate existing tokens, and disabled, suspended, deleted, or expired accounts cannot authenticate.

## Client configuration

For Codex, keep the token in an environment variable and add this to `~/.codex/config.toml`:

```toml
[mcp_servers.wildduck]
url = "https://mail.example.com/mcp"
bearer_token_env_var = "WILDDUCK_MCP_TOKEN"
```

Codex supports Streamable HTTP bearer authentication as documented in its [MCP configuration reference](https://developers.openai.com/codex/mcp).

Claude Code can use an environment-expanded project or user configuration:

```json
{
  "mcpServers": {
    "wildduck": {
      "type": "http",
      "url": "https://mail.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${WILDDUCK_MCP_TOKEN}"
      }
    }
  }
}
```

Alternatively, add it directly with `claude mcp add --transport http`; see the [Claude Code MCP documentation](https://docs.anthropic.com/en/docs/claude-code/mcp). Avoid putting the plaintext token in a tracked configuration file or shell history.

## Available tools

The service exposes five read-only tools:

| Tool | Result |
| --- | --- |
| `get_account` | Safe account profile, primary address, aliases, and quota usage |
| `list_mailboxes` | Mailbox paths, optional hidden mailboxes, counters, and sizes |
| `list_messages` | Paged message summaries for one exact mailbox path or ID |
| `search_messages` | Paged message summaries using either the REST `q` grammar or typed filters |
| `get_message` | Safe envelope data, flags, attachment metadata, and bounded parsed bodies |

List and search calls default to 20 results and never return more than 50. Message bodies are limited to `maxBodyChars` and include explicit original, returned, and truncation lengths. HTML is returned only when `body_format` is `html` or `both`.

MCP reads do not mark messages as seen or update message flags, counters, modification indexes, or notification streams. The service does not expose raw EML, arbitrary headers or metadata, attachment content, forwarding targets, draft storage references, outbound queue state, BIMI images, resources, prompts, or write tools.

Mail content is untrusted data. The server instructions explicitly tell clients not to follow links, fetch URLs, execute commands, disclose secrets, or interpret instructions found in messages.

## Operations

Prometheus includes MCP service state, authentication results, bounded HTTP and tool duration metrics, result counts, and result-size histograms. MCP logs contain only the token record ID, user ID, tool name, status, duration, and result size. Bearer secrets, tool arguments, search terms, headers, and message content are not logged.
