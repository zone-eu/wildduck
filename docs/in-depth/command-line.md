# Administrating WildDuck via command line

## REST api

Well, the whole idea is, we can administrate wilduck via the REST api.
So we are crafting http queries, and sending it via `curl`.

You can save these commands to `~/.bashrc` file (which is executed if you are coming through ssh,
the `~/.profile` file is for interactive login).
Not as *aliases* (because *alias* can not have arguments), but you can save them
as bash *functions*, which behave exactly like *aliases* but can have arguments too.

## Saving functions to `~/.bashrc` file

Here is an example:

```
wduck-get-user() {
  echo "Geeting info about user with id: $1"
  curl -i http://localhost:8080/users/$1

}
```

### Crash course about bash functions:

You only specify the function as `functionname() { ... }`, no need to specifying the
arguments. You can call it either with or without arguments or with multiple arguments:

```
$ functionname
$ functionname myargument1
$ functionname myargument1 my2
```

If you save it to `~/.bashrc`, then you can call it as any `alias` defined there.

### Better to source our file in `.bashrc` rather then defining there

It is better to have a separate file for wildduck related commands, and
`source` it in `bashrc` file, then polluting it too much.

So we create a file named `~/.wildduck.commands`, and `source` it.
Paste this at the end of `~/.bashrc` file:

```
# include .wildduck.commands if it exists
if [ -f $HOME/.wildduck.commands ]; then
    . $HOME/.wildduck.commands
    echo ".wildduck.commands file has been sourced"
fi
```

Please note `. file` is the same as `source file`. But dot itself is
POSIX compatible, while `source` is bash builtin (and some other shells too),
but bash itself [does not make a distinction between dot and source](https://stackoverflow.com/a/20094373).

## List of commands

In the below examples, we are taking our commands from [wildduck API](https://docs.wildduck.email/api).
Please refer to the official api for the latest version if this guide gets old or out of sync.

### List of all users in wildduck

```
curl -i http://localhost:8080/users
```

Function snippet to be saved in :~/.wildduck.commands`:

```
wduck-users() {
  echo "List of all users"
  curl -i http://localhost:8080/users
}
```

### Query user information

```
  curl -i http://localhost:8080/users/$USERID
```

Function snippet to be saved in :~/.wildduck.commands`:

```
wduck-user() {
  USERID=$1
  echo "Querying info about user $USERID"
  curl -i http://localhost:8080/users/$USERID
}
```

### Searching messages in the whole database (chinese char)

Some mongodb foo:
```
mongo
> use wildduck
> db.
messages.
find({'headers.value': /[姚轉]/ }).
toArray().
map(doc => '/users/' + doc.user.str + '/mailboxes/' + doc.mailbox.str + '/messages/' + doc.uid )

Example output:
[
  "/users/5b1xxx8dc5/mailboxes/5b1xxxdc6/messages/14343",
  "/users/5b1xxx8dc5/mailboxes/5b1xxxdc6/messages/10837",
]
```

Where `doc.user` is the owner of the mailbox, `doc.mailbox` is the mailbox where the message located (inbox, sent, draft, etc), and `doc.uid` is a number, what wildduck uses for message id. It is independent from mongodb builtin `doc._id`.

Function snippet to be saved in :~/.wildduck.commands`:

```
wduck-message-delete() {
  URL=$1
  echo "Delete(format: /users/USERID/mailboxes/MAILBOXID/messages/UID) message: $URL"
  curl -i -XDELETE http://localhost:8080$URL
}
```
Use it like:
```
wduck-message-delete /users/5b1xxx8dc5/mailboxes/5b1xxxdc6/messages/10837
```
where xxx are real chars.

Or in a shell script:
```
#! /bin/bash

source ~/.wildduck.commands

declare -a arr=(
"/users/5b1xxxc5/mailboxes/5b1xxxc6/messages/14343"
"/users/5b3xxx54/mailboxes/5b3xxx55/messages/10837"
)
for i in "${arr[@]}"
do
  wduck-message-delete $i
done

```
