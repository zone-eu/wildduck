# Roles and permissions

WildDuck roles are persistent records in the `roles` collection of the users database. A role's **name is its identity**: the MongoDB `_id` is the role name string, and API tokens and user assignments store that same name. Role grants use AccessControl resource maps, for example `{"messages":{"read:any":["*"]}}`. A role may also define named boolean capabilities in a sibling `custom` map, for example `{"custom":{"export":true,"billing":false}}`. The map is `config.api.roles.<role>.custom` in configuration and `permissions.custom` in role API requests and responses. WildDuck stores and resolves these booleans for consumers such as webmail; it does not enforce custom capabilities on its routes. The name `custom` is reserved; other resource names remain unrestricted.

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

Creating a role or replacing its permissions requires every grant to fit within the caller's effective permissions, including scopes, attribute allowlists, exclusions, and custom capabilities. `roles:update:any` alone cannot add privileges to the caller's own role. The explicit `rolegrants:update:any` grant allows unrestricted delegation; it is bundled only with `root`.

In API paths, `:role` is the name. In responses, `id` and `name` are the same identity. User policy `role` values are names as well. The `bin/access-tokens provision <user> <role>` CLI accepts a role name and stores it directly. For example:

```sh
./bin/access-tokens --config=/path/to/server/config.toml provision reader api:read
```

Use the server's real configuration because the CLI writes token data to its databases. The bundled `api:read` role is defined in [`config/roles.json`](../../config/roles.json), included as `config.api.roles` by `config/api.toml`. It has service-wide `read:any` grants for its configured resources and does not grant create, update, or delete access.

## Deletion and assignments

Deleting a custom role queues a durable `role-delete` task, then tombstones the record. The tombstone retains the name and reserves it permanently. This ensures old tokens cannot acquire new permissions if a deleted name is later reused. Explicit tokens referencing deleted or unknown names fail closed. A user assignment to a deleted role falls back to the default `user` role during authentication; the background task also clears stored assignments. System roles cannot be tombstoned.

Ordinary user login tokens use the user's current assigned role, defaulting to `user`. Existing named user assignments and tokens remain valid; no token reissue or role-name migration is needed. Explicit service-token roles remain in effect; user-bound service tokens also apply that account's restrictions. MCP tokens retain their role and apply the user's restrictions. Role resolution happens per authenticated request, so role changes take effect on the next request. Active requests and streams keep their admitted permissions.

## Per-user restrictions

Optional `role` and `permissions` fields can be supplied through `POST /users` and `PUT /users/:user`. The `role` is a role name; `role: null` restores the default `user` role. Omitting either field leaves it unchanged. Writes require the ordinary `users` create/update grant and pass through its field allowlist. Each policy field that survives that filter also requires `userpermissions:create:any` for creation, or `userpermissions:update:own` / `userpermissions:update:any` according to the target account on update; the policy fields themselves are filtered through the matching `userpermissions` attribute allowlist. Policy reads are unchanged: `readAny('users')` may see stored policy for any user, while `readOwn('users')` may see it only for the authenticated user's account, subject to response attribute allowlists.

Delegation is checked against the caller's effective grants. When a role or restriction policy is written, the assigned role's grants (or the existing role, including the default or deleted-role fallback, for permissions-only or null writes) must fit within the caller's effective grants. This applies to own/any scopes, attributes, globs and exclusions, resource restrictions, and custom boolean capabilities. Clearing restrictions therefore cannot give an account permissions beyond the caller's ceiling. Explicit `rolegrants:update:any` is unrestricted delegation authority: it allows managing grants for arbitrary resources and defining custom capability names. Only the bundled `root` role has this authority. There are no hardcoded role-name bypasses; the configured role grants determine authority.

For example, this update disables label creation and deletion and filter creation:

```json
{
    "permissions": {
        "labels": { "create": false, "delete": false },
        "filters": { "create": false }
    }
}
```

Restrictions accept resource names and boolean `create`, `read`, `update`, and `delete` settings, plus a `custom` map of named boolean capabilities. Unknown resource names are accepted but have no effect unless application code checks that resource. In `custom`, only names defined by the assigned role are considered. Missing settings inherit the role. `false` denies a resource operation or custom capability, including an inherited any grant or a route's own-to-any fallback. `true` does not grant access beyond the role and cannot enable a role capability that is absent or false. Missing role capabilities are denied. Restrictions do not change attribute filtering or add any-resource access. A supplied map replaces the previous map; `permissions: null` or `{}` clears restrictions.

User detail and list responses can include `effectivePermissions` for the authenticated user's own account. Authorized authentication and preauthentication responses can also include it when the caller may read that account's policy. Its shape is `{ "resources": { "resource": { "create:own": true, "create:any": false, "read:own": true, "read:any": false, "update:own": false, "update:any": false, "delete:own": false, "delete:any": false } }, "custom": { "capability": true } }`. Resource entries and custom capability names enumerate only those defined by the resolved role; omitted entries are denied. User responses resolve the admitted request's role and restrictions, including an explicit service token's role; authentication responses resolve the account's assigned role with the usual default and deleted-role fallback. The booleans use the same AccessControl decisions as route checks, including `any` grants implying `own`. Stored `role` and `permissions` fields keep their existing form. Resource booleans do not describe field access: the underlying resource attribute allowlists still apply. The effective result has no attribute allowlist of its own, but the enclosing response still follows the caller's normal read grant and response field allowlist.

A missing or `null` user role assignment means the default `user` role. Role assignments are validated against active records when written.

The user-handler and role-access modules can be loaded by library consumers when `config.api` or `config.api.roles` is absent; role enforcement remains driven by the available configured and persisted definitions.

## Token guidance

For public front ends, keep the application and WildDuck API on separate servers, require valid API tokens, and never store the root token in the public application's configuration. Use a narrowly scoped service role to call `/authenticate`, then use the resulting user-bound token for that account's API requests.
