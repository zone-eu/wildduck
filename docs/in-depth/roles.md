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

### Considerations

When building a publicly available front end application to access mailboxes consider the following:

-   Host your public app and WIldDuck API in different servers
-   Edit WildDuck API config file to always require valid tokens
-   Do not store actual root token in your public application config
-   Generate an "authentication" role token for `/authenticate` calls to be used by your public app
-   Request user tokens from authentication calls
-   Use user tokens for normal API requests

This guarantees that even if your application code and config is somehow leaked it does not allow access to the mailboxes of other users.
