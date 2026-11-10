# Roles

WildDuck API can be accessed either by using the root token set in configuration file or by creating role based tokens. Root token can be used for everything while role based tokens are always limited.

Role based tokens that are bound to a specific user can be generateid by requesting a token via the authentication call (set `token:true`):

```
$ curl -i -XPOST http://localhost:8080/authenticate \
  -H 'Content-type: application/json' \
  -d '{
    "username": "myuser",
    "password": "secretpass",
    "scope": "master",
    "token": "true"
  }

> {
>   "success": true,
>   ..
>   "token": "secret-token"
>  }'
```

Such token is limited for API requests that are related to this specific user only (eg. you can not list mailboxes or messages for any other user) and also have a lifetime thus needing renewing after expiration.

For any other role (see role definitions [here]()) you can use _access-tokens_ script in the bin folder.

```
$ ./bin/access-tokens --config="/path/to/server/config.toml" provision admin root
Generated access token for admin[root]:
3ab3a00ae63227673ab423b3be3afabe5e185b4c
```

In this case `--config="/etc/wildduck/wildduck.toml` points to server specific configuration file, "admin" is username for the token (this is not a user account but just a name to use in access logs etc) and "root" is role. You need to use actual production config as the tokens are written to the database.

The `api:read` role provides service-wide read-only access to API resources. It uses `read:any` permissions, so it is not scoped to a single account. It does not grant create, update, or delete access. Provision a reader token with:

```
$ ./bin/access-tokens --config="/path/to/server/config.toml" provision reader api:read
```

The available roles, including `api:read`, are defined by `config.api.roles` in the server configuration.

### Per-user restrictions

Optional `role` and `permissions` fields can be supplied through `POST /users` and `PUT /users/:user`. Writes use the normal user-resource grants and field filtering; there is no separate root-only write rule. The existing field allowlists still prevent an ordinary user from changing their own policy unless their effective permissions explicitly allow those fields. Named roles remain in `config/roles.json`; the assigned role must be configured.

Policy visibility follows the normal user read grants, with response attribute allowlists still applied. A credential with `readAny('users')` may see stored `role` and `permissions` for any user; `readOwn('users')` may see them only for the authenticated user's own account. This applies to `GET /users/:user`, matching rows in `GET /users`, and authorized `/preauth` or `/authenticate` responses for the corresponding user. No special root rule applies to policy reads.

For example, this update disables label creation and deletion and filter creation:

```json
{
    "role": "user",
    "permissions": {
        "labels": { "create": false, "delete": false },
        "filters": { "create": false }
    }
}
```

Permissions accept recognized resource names and boolean `create`, `read`, `update`, and `delete` settings only. Missing settings inherit the role. `false` denies the entire operation, including an inherited any grant or a route's own-to-any fallback. `true` adds no restriction and cannot grant access the role lacks. Restrictions never grant any-resource access or change the role's attribute filtering; per-user attribute lists are unsupported.

Omitting a field leaves it unchanged. `role: null` restores the default `user` role. `permissions: null` or `{}` clears restrictions. A supplied permission map replaces the previous map rather than merging with it.

Ordinary login tokens use the user's current assigned role, defaulting to `user`. Explicit service-token roles remain in effect; user-bound service tokens also apply that user's restrictions. MCP tokens retain their MCP role and apply the user's restrictions. Each authenticated request loads current settings, so existing tokens observe edits on their next request. Invalid stored policies or unknown assigned roles fail closed. Existing users need no migration. Enforcement remains at existing API permission checks; active requests and streams keep their admitted permissions.

### Considerations

When building a publicly available front end application to access mailboxes consider the following:

-   Host your public app and WIldDuck API in different servers
-   Edit WildDuck API config file to always require valid tokens
-   Do not store actual root token in your public application config
-   Generate an "authentication" role token for `/authenticate` calls to be used by your public app
-   Request user tokens from authentication calls
-   Use user tokens for normal API requests

This guarantees that even if your application code and config is somehow leaked it does not allow access to the mailboxes of other users.
