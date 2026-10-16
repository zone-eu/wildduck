# Labels

Each label is an independent record in the main database:

```javascript
{ _id: ObjectId('...'), user: ObjectId('...'), name: 'Projects', metaData: { color: 'blue' }, slot: 0, created: ISODate('...') }
```

Labels have no parents or descendants. The unique `{ user: 1, name: 1 }` index scopes names to
an account; `{ user: 1, slot: 1 }` reserves one of 5,000 slots for each label.
Message and filter assignments store label IDs in `messages.labels` and
`filters.action.labels`. Ordinary IMAP flags stay in `messages.flags`.

`POST /users/:user/labels` accepts `{ "name": "Projects", "metaData": { "color": "blue" } }`.
Creating the same name again returns its existing ID and metadata. The name is
at most 256 characters. The metadata is an optional JSON object. Creating a
label does not assign it to a message. REST message and filter actions that use
a label name register it automatically.

`GET /users/:user/labels` lists `id`, `name`, and optional `metaData` for each
label, including labels without messages. `?counters=true` adds `total` and
`unseen`. `GET /users/:user/labels/:label` fetches one label by its ID, allowing
an IMAP client to resolve an ID seen in a flag. `PUT /users/:user/labels/:label`
updates the name or metadata without changing the ID. `DELETE` on that route
schedules removal of that label alone and its message and filter assignments.
Deletion sends per-message flag updates to connected clients. Label names are
matched exactly by REST search, including leading and trailing whitespace.

REST message search accepts labels through both the structured `label` filter
(a label name or ID) and the `q` parameter's `label:` term. For either form,
an exact 24-hex value first resolves as an ID, but only when it identifies an
active label owned by the searched user. If that ID is missing, belongs to
another user, or is being deleted, search falls back to an exact label-name
lookup, again restricted to active labels owned by the searched user. This
allows a label whose name is 24 hexadecimal characters to match
when no active owned ID takes precedence. If neither lookup matches, the filter
matches no messages. Names preserve exact case and whitespace; they are not
trimmed or case-folded.

`label:` terms follow the boolean rules of other search terms: terms combine
with `AND` by default, `OR` expresses alternatives, and a leading `-` negates
the term.

```text
label:Work OR label:Personal
label:Work AND label:Urgent
label:507f1f77bcf86cd799439011 OR label:Personal
label:507f1f77bcf86cd799439011 AND label:Urgent
```

Quote names that contain spaces. Quoted label names preserve exact whitespace
and case, including leading and trailing spaces.

```text
label:"Projects"
label:" Projects "
```

Prefix a label filter with `-` to exclude messages assigned that label:

```text
-label:Work
```

An unknown label name or ID, another user's label ID, or a label being deleted matches no messages. Its
negated form therefore excludes nothing.

IMAP `FETCH FLAGS` represents an assigned label as `$wdlabel$` followed by its
24-character lowercase ObjectId. For example, `$wdlabel$507f1f77bcf86cd799439011`.
`STORE` and `APPEND` resolve that form only when the ID names an active label
owned by the message's user. A valid match becomes an assignment in
`messages.labels`. Every other flag, including an unknown ID, a malformed ID,
or an ordinary custom flag such as `$label1`, remains in `messages.flags`.
IMAP does not create labels. `SEARCH KEYWORD` and `UNKEYWORD` use the same ID
form to match assignments, and still search ordinary flags as ordinary flags.

Install the label indexes before enabling label writes.
