'use strict';

/** Register bounded account resource tools backed by the authenticated REST reader. */
function registerResourceTools({ tool, run, reader, z, ACTION, mailboxRef, maxResults, defaultResults }) {
    const id = z
        .string()
        .regex(/^[0-9a-fA-F]{24}$/)
        .transform(value => value.toLowerCase());

    const text = (limit = 255) => z.string().trim().min(1).max(limit);
    const labelName = z.string().min(1).max(256);

    const metadata = z
        .record(z.string(), z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]))
        .refine(value => Object.keys(value).length <= 50);

    const result = z.object({ success: z.boolean().optional() }).passthrough();
    const path = value => encodeURIComponent(value);

    // McpReader prefixes every path with the authenticated user's ID.
    const own = suffix => `/${suffix}`;
    const invoke = (name, fn) => async args => run(name, () => fn(args));

    const register = (name, action, description, input, handler, annotations) =>
        tool(name, action, {
            description,
            inputSchema: z.strictObject(input),
            outputSchema: result,
            ...(annotations ? { annotations } : {})
        }, handler);

    const deletions = {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
    };
    const updates = {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
    };

    const mailboxInput = { mailbox: mailboxRef };

    register(
        'get_mailbox',
        ACTION.READ,
        'Get one mailbox by exact path or mailbox ID.',
        mailboxInput,
        invoke('get_mailbox', async ({ mailbox }) => {
            const mailboxId = await reader.mailboxId(mailbox);
            return reader.get(own(`mailboxes/${path(mailboxId)}`), {});
        })
    );
    register(
        'update_mailbox',
        ACTION.WRITE,
        'Update mailbox settings. Only supplied fields are changed.',
        {
            mailbox: mailboxRef,
            path: text(1024).optional(),
            retention: z.number().int().nonnegative().optional(),
            subscribed: z.boolean().optional(),
            encryptMessages: z.boolean().optional(),
            hidden: z.boolean().optional()
        },
        invoke('update_mailbox', async ({ mailbox, ...body }) => {
            const mailboxId = await reader.mailboxId(mailbox);
            return reader.put(own(`mailboxes/${path(mailboxId)}`), body);
        }),
        updates
    );
    register(
        'delete_mailbox',
        ACTION.DESTRUCTIVE,
        'Delete a mailbox by exact path or mailbox ID.',
        mailboxInput,
        invoke('delete_mailbox', async ({ mailbox }) => {
            const mailboxId = await reader.mailboxId(mailbox);
            return reader.delete(own(`mailboxes/${path(mailboxId)}`), {});
        }),
        deletions
    );

    const filterId = { filter: id };

    register(
        'get_filter',
        ACTION.READ,
        'Get one incoming mail filter.',
        filterId,
        invoke('get_filter', ({ filter }) => reader.get(own(`filters/${filter}`), {}))
    );
    const filterQuery = z.strictObject({
        from: text().optional(),
        to: text().optional(),
        subject: text().optional(),
        listId: text().optional(),
        text: text().optional(),
        ha: z.boolean().optional(),
        size: z.number().int().optional()
    });
    const filterAction = z.strictObject({
        seen: z.boolean().nullable().optional(),
        flag: z.boolean().nullable().optional(),
        delete: z.boolean().nullable().optional(),
        spam: z.boolean().nullable().optional(),
        mailbox: id.optional(),
        labels: z.array(id).max(100).optional()
    });

    register(
        'update_filter',
        ACTION.WRITE,
        'Update supplied fields on an incoming mail filter.',
        {
            filter: id,
            name: text().optional(),
            query: filterQuery.optional(),
            action: filterAction.optional(),
            disabled: z.boolean().optional()
        },
        invoke('update_filter', ({ filter, ...body }) => reader.put(own(`filters/${filter}`), body)),
        updates
    );
    register(
        'delete_filter',
        ACTION.DESTRUCTIVE,
        'Delete an incoming mail filter.',
        filterId,
        invoke('delete_filter', ({ filter }) => reader.delete(own(`filters/${filter}`), {})),
        deletions
    );

    const labelId = { label: id };

    register(
        'get_label',
        ACTION.READ,
        'Get one persistent label.',
        labelId,
        invoke('get_label', ({ label }) => reader.get(own(`labels/${label}`), {}))
    );

    register(
        'create_label',
        ACTION.WRITE,
        'Create or retrieve a persistent label.',
        { name: labelName, metaData: metadata.optional() },
        invoke('create_label', ({ name, metaData }) =>
            reader.post(own('labels'), {
                name,
                ...(metaData === undefined ? {} : { metaData })
            })
        )
    );

    register(
        'rename_label',
        ACTION.WRITE,
        'Update a persistent label while preserving its ID.',
        { label: id, name: labelName.optional(), metaData: metadata.optional() },
        invoke('rename_label', ({ label, ...body }) => reader.put(own(`labels/${label}`), body)),
        updates
    );

    register(
        'delete_label',
        ACTION.DESTRUCTIVE,
        'Schedule deletion of a persistent label and its assignments.',
        labelId,
        invoke('delete_label', ({ label }) => reader.delete(own(`labels/${label}`), {})),
        deletions
    );

    register(
        'get_label_counters',
        ACTION.READ,
        'Get message counters for one label name.',
        { label: labelName.refine(value => value !== '.' && value !== '..'), searchable: z.boolean().default(true) },
        invoke('get_label_counters', ({ label, searchable }) =>
            reader.get(own(`label-counters/${path(label)}`), { searchable })
        )
    );

    const flagInput = {
        flag: z.enum(['seen', 'answered', 'flagged', 'deleted', 'draft', 'unread']),
        searchable: z.boolean().default(true)
    };
    register(
        'get_flag_counters',
        ACTION.READ,
        'Get message counters for one supported system flag.',
        flagInput,
        invoke('get_flag_counters', ({ flag, searchable }) =>
            reader.get(own(`flag-counters/${flag}`), { searchable })
        )
    );

    register(
        'get_flagged_counter',
        ACTION.READ,
        'Get the compatibility flagged message counter.',
        { searchable: z.boolean().default(true) },
        invoke('get_flagged_counter', ({ searchable }) => reader.get(own('flagged-counter'), { searchable }))
    );

    register(
        'delete_autoreply',
        ACTION.DESTRUCTIVE,
        'Delete the authenticated account vacation autoreply.',
        {},
        invoke('delete_autoreply', () => reader.delete(own('autoreply'), {})),
        deletions
    );

    const addressRegisterLimit = Math.min(maxResults, 100);

    register(
        'list_addresses',
        ACTION.READ,
        'List addresses registered for the authenticated account.',
        {},
        invoke('list_addresses', () => reader.get(own('addresses'), {}))
    );
    const address = z.string().trim().min(3).max(320);

    register(
        'get_address',
        ACTION.READ,
        'Get one address by ID.',
        { address: id },
        invoke('get_address', ({ address: value }) => reader.get(own(`addresses/${value}`), {}))
    );

    register(
        'create_address',
        ACTION.WRITE,
        'Create an address for the authenticated account.',
        {
            address,
            name: text(255).optional(),
            main: z.boolean().optional(),
            allowWildcard: z.boolean().optional(),
            tags: z.array(text(128)).max(50).optional(),
            metaData: metadata.optional()
        },
        invoke('create_address', body => reader.post(own('addresses'), body))
    );

    register(
        'update_address',
        ACTION.WRITE,
        'Update supplied fields on an address by ID.',
        {
            id,
            address: address.optional(),
            name: text(255).optional(),
            main: z.boolean().optional(),
            tags: z.array(text(128)).max(50).optional(),
            metaData: metadata.optional()
        },
        invoke('update_address', ({ id: addressId, ...body }) => reader.put(own(`addresses/${addressId}`), body)),
        updates
    );

    register(
        'delete_address',
        ACTION.DESTRUCTIVE,
        'Delete an address by ID.',
        { address: id },
        invoke('delete_address', ({ address: value }) => reader.delete(own(`addresses/${value}`), {})),
        deletions
    );

    register(
        'list_address_register',
        ACTION.READ,
        'Search address register entries for the authenticated account.',
        {
            query: z.string().trim().max(255),
            limit: z.number().int().min(1).max(addressRegisterLimit).default(Math.min(defaultResults, addressRegisterLimit))
        },
        invoke('list_address_register', args => reader.get(own('addressregister'), args))
    );

    register(
        'update_address_register_entry',
        ACTION.WRITE,
        'Update an address register entry by ID.',
        { id, name: text(255).optional(), disabled: z.boolean() },
        invoke('update_address_register_entry', ({ id: entryId, ...body }) =>
            reader.put(own(`addressregister/${entryId}`), body)
        ),
        updates
    );
}

module.exports = { registerResourceTools };
