# Roles and permissions

WildDuck roles are persistent records in the `roles` collection of the users database. A role's **name is its identity**: the MongoDB `_id` is the role name string, and API tokens and user assignments store that same name. Role grants use AccessControl resource maps, for example `{"messages":{"read:any":["*"]}}`.

## System roles

`config.api.roles` is the source of role grants and names. In the bundled configuration, `config/api.toml` includes `roles.json` under `[roles]`, so `config/roles.json` supplies the bundled definitions. The bundled roles include `root`, `user`, `api:read`, and service roles such as `audit`, `auditclient`, and `tokenAuth`. Initialization accepts any set of configured role names. System role descriptions are empty.

API startup and worker startup initialize the role catalog from `config.api.roles`. Initialization seeds or restores configured role records by source name. The internal `systemSource` marker detects a conflict when an unrelated record occupies a configured name. Configuration changes take effect at the next startup; there is no reconciliation on configuration reload or background synchronization. Custom roles are not overwritten.

The API considers a role system-managed solely when its MongoDB `isSystem` flag is true. Such roles cannot be updated or deleted through the API. A role with `isSystem: false` is editable, even if its name appears in `config.api.roles`; startup restores its configured fields, including the flag. Configure role grants through `config.api.roles` (the bundled `config/api.toml` includes `roles.json`). Custom role names are immutable after creation; update can replace permissions and description.

## Managing custom roles

Role administration uses the `roles` resource grants, with `createAny`, `readAny`, `updateAny`, and `deleteAny`. Root has these grants by default. The API provides:

- `GET /roles` and `GET /roles/:role` to list or fetch active roles.
- `POST /roles` with `name`, optional `description`, and required `permissions` to create a role.
- `PUT /roles/:role` with optional `description` and/or `permissions` to replace those fields.
- `DELETE /roles/:role` to delete a custom role.

In API paths, `:role` is the name. In responses, `id` and `name` are the same identity. User policy `role` values are names as well. The `bin/access-tokens provision <user> <role>` CLI accepts a role name and stores it directly. For example:

```sh
./bin/access-tokens --config=/path/to/server/config.toml provision reader api:read
```

Use the server's real configuration because the CLI writes token data to its databases. The bundled `api:read` role is defined in [`config/roles.json`](../../config/roles.json), included as `config.api.roles` by `config/api.toml`. It has service-wide `read:any` grants for its configured resources and does not grant create, update, or delete access.

## Deletion and assignments

Deleting a custom role queues a durable `role-delete` task, then tombstones the record. The tombstone retains the name and reserves it permanently. This ensures old tokens cannot acquire new permissions if a deleted name is later reused. Explicit tokens referencing deleted or unknown names fail closed. A user assignment to a deleted role falls back to the default `user` role during authentication; the background task also clears stored assignments. System roles cannot be tombstoned.

Ordinary user login tokens use the user's current assigned role, defaulting to `user`. Existing named user assignments and tokens remain valid; no token reissue or role-name migration is needed. Explicit service-token roles remain in effect; user-bound service tokens also apply that account's restrictions. MCP tokens retain their role and apply the user's restrictions. Role resolution happens per authenticated request, so role changes take effect on the next request. Active requests and streams keep their admitted permissions.

## Per-user restrictions

Optional `role` and `permissions` fields can be supplied through `POST /users` and `PUT /users/:user`. The `role` is a role name; `role: null` restores the default `user` role. Omitting either field leaves it unchanged. Writes use normal user-resource grants and field filtering; there is no separate root-only write rule. Policy visibility follows normal user read grants and response attribute allowlists: `readAny('users')` may see stored policy for any user, while `readOwn('users')` may see it only for the authenticated user's account.

For example, this update disables label creation and deletion and filter creation:

```json
{
    "permissions": {
        "labels": { "create": false, "delete": false },
        "filters": { "create": false }
    }
}
```

Restrictions accept resource names and boolean `create`, `read`, `update`, and `delete` settings. Unknown resource names are accepted but have no effect unless application code checks that resource. Missing settings inherit the role. `false` denies the operation, including an inherited any grant or a route's own-to-any fallback. `true` does not grant access beyond the role. Restrictions do not change attribute filtering or add any-resource access. A supplied map replaces the previous map; `permissions: null` or `{}` clears restrictions.

A missing or `null` user role assignment means the default `user` role. Role assignments are validated against active records when written.

## Token guidance

For public front ends, keep the application and WildDuck API on separate servers, require valid API tokens, and never store the root token in the public application's configuration. Use a narrowly scoped service role to call `/authenticate`, then use the resulting user-bound token for that account's API requests.
