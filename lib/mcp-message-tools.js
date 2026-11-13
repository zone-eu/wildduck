'use strict';

const consts = require('./consts');

// All paths are relative to the authenticated reader. Neither a tool input nor a stored
// message reference can choose another account; the REST routes enforce resource ownership.
module.exports = function registerMessageTools({ tool, run, reader, z, ACTION, mailboxRef, uidRef }) {
    const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/);
    const uidSet = z.string().min(1).max(4096).regex(/^[1-9]\d*(,[1-9]\d*)*$|^[1-9]\d*:([1-9]\d*|\*)$/);

    // Message mutation routes take label names, whereas filter actions take persistent IDs.
    const labels = z.array(z.string().min(1).max(consts.MAX_LABEL_LENGTH || 256)).max(1000);

    const date = z.iso.datetime({ offset: true });
    const textQuery = z.string().trim().min(1).max(1024);
    const metaData = z.record(z.string(), z.unknown());
    const response = z.object({ success: z.boolean().optional() }).passthrough();

    const maxDownload = consts.MCP_MAX_DOWNLOAD_BYTES || 65536;
    const downloadResponse = z.object({
        data: z.string(),
        encoding: z.literal('base64'),
        contentType: z.string(),
        offset: z.number().int().nonnegative(),
        returnedBytes: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative().optional(),
        hasMore: z.boolean()
    });

    const messagePath = async (mailbox, message) =>
        `/mailboxes/${encodeURIComponent(await reader.mailboxId(mailbox))}/messages${message === undefined ? '' : `/${encodeURIComponent(message)}`}`;

    const register = (name, action, description, inputSchema, handler, outputSchema = response) =>
        tool(name, action, { description, inputSchema, outputSchema }, async args => run(name, () => handler(args)));

    const labelChanges = {
        labels: labels.optional(),
        addLabels: labels.optional(),
        removeLabels: labels.optional()
    };

    const validLabelChanges = values => values.labels === undefined || (values.addLabels === undefined && values.removeLabels === undefined);

    const updateFields = {
        moveTo: objectId.optional(),
        updateThread: z.boolean().optional(),
        updateThreadAll: z.boolean().optional(),
        seen: z.boolean().optional(),
        deleted: z.boolean().optional(),
        flagged: z.boolean().optional(),
        markHam: z.boolean().optional(),
        draft: z.boolean().optional(),
        expires: z.union([date, z.literal(false)]).optional(),
        metaData: metaData.optional(),
        ...labelChanges
    };

    const updateSchema = fields =>
        z.strictObject(fields).refine(validLabelChanges, { message: 'labels cannot be combined with addLabels or removeLabels' });

    for (const [name, messageSchema] of [
        ['update_message', uidRef],
        ['update_messages', uidSet]
    ]) {
        register(
            name,
            ACTION.DESTRUCTIVE,
            'Update message flags, labels, expiry or metadata, or move messages. Thread options can affect multiple messages; no message is sent.',
            updateSchema({ mailbox: mailboxRef, message: messageSchema, ...updateFields }),
            async ({ mailbox, message, ...updates }) =>
                name === 'update_messages'
                    ? reader.put(await messagePath(mailbox), { message, ...updates })
                    : reader.put(await messagePath(mailbox, message), updates)
        );
    }

    const search = z.strictObject({
        q: textQuery.optional(),
        mailbox: objectId.optional(),
        id: uidSet.optional(),
        thread: objectId.optional(),
        query: z.string().trim().min(1).max(255).optional(),
        or: z
            .strictObject({
                query: z.string().trim().min(1).max(255).optional(),
                from: textQuery.optional(),
                to: textQuery.optional(),
                subject: textQuery.optional()
            })
            .optional(),
        from: textQuery.optional(),
        to: textQuery.optional(),
        subject: textQuery.optional(),
        datestart: date.optional(),
        dateend: date.optional(),
        minSize: z.number().nonnegative().optional(),
        maxSize: z.number().nonnegative().optional(),
        attachments: z.literal(true).optional(),
        flagged: z.literal(true).optional(),
        unseen: z.literal(true).optional(),
        seen: z.literal(true).optional(),
        label: z.string().min(1).max(256).optional(),
        useAndSearch: z.boolean().optional(),
        searchable: z.boolean().optional()
    });

    const action = updateSchema({
        moveTo: objectId.optional(),
        seen: z.boolean().optional(),
        flagged: z.boolean().optional(),
        delete: z.boolean().optional(),
        ...labelChanges
    })
        .refine(value => Object.keys(value).length > 0, { message: 'At least one action is required' })
        .refine(value => value.delete !== true || Object.keys(value).length === 1, { message: 'delete cannot be combined with another action' });

    register(
        'apply_message_search',
        ACTION.DESTRUCTIVE,
        'Schedule changes to every message matching a search. An empty search matches all messages in the account. The API returns a background task ID.',
        z.strictObject({ search, action }),
        ({ search: query, action: changes }) => reader.post('/search', { ...query, action: changes })
    );

    register(
        'delete_message',
        ACTION.DESTRUCTIVE,
        'Delete a stored message, optionally including its thread in this mailbox. Draft deletion is permanent; other messages follow API archive retention.',
        z.strictObject({ mailbox: mailboxRef, message: uidRef, updateThread: z.boolean().optional() }),
        async ({ mailbox, message, updateThread }) => reader.delete(await messagePath(mailbox, message), { updateThread })
    );

    register(
        'empty_mailbox',
        ACTION.DESTRUCTIVE,
        'Delete every message in a mailbox. async schedules a background task. skipArchive bypasses the normal archive retention.',
        z.strictObject({ mailbox: mailboxRef, async: z.boolean().optional(), skipArchive: z.boolean().optional() }),
        async ({ mailbox, ...query }) => reader.delete(await messagePath(mailbox), query)
    );

    const maxInputChars = 1024 * 1024;
    const base64 = z.string().min(1).max(maxInputChars).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
    const address = z.strictObject({ name: z.string().max(255).optional(), address: z.email() });
    const addresses = z.array(address).max(1000);

    const uploadFields = {
        mailbox: mailboxRef,
        date: date.optional(),
        unseen: z.boolean().optional(),
        flagged: z.boolean().optional(),
        labels: labels.optional(),
        raw: base64.optional().describe('Base64 RFC822 source. If present, overrides structured message content.'),
        from: address.optional(),
        replyTo: address.optional(),
        to: addresses.optional(),
        cc: addresses.optional(),
        bcc: addresses.optional(),
        headers: z
            .array(z.strictObject({ key: z.string().min(1).max(255).regex(/^[^:\r\n]+$/), value: z.string().max(100 * 1024) }))
            .max(1000)
            .optional(),
        subject: z.string().max(2048).optional(),
        text: z.string().max(maxInputChars).optional(),
        html: z.string().max(maxInputChars).optional(),
        attachments: z
            .array(
                z.strictObject({
                    filename: z.string().max(255).optional(),
                    contentType: z.string().max(255).optional(),
                    encoding: z.literal('base64').optional(),
                    contentTransferEncoding: z.enum(['base64', 'quoted-printable', '7bit', '8bit', 'binary']).optional(),
                    content: base64,
                    cid: z.string().max(255).optional(),
                    contentDisposition: z.enum(['inline', 'attachment']).optional()
                })
            )
            .max(100)
            .optional(),
        metaData: metaData.optional(),
        reference: z
            .strictObject({
                mailbox: objectId,
                id: uidRef,
                action: z.enum(['reply', 'replyAll', 'forward']),
                attachments: z.union([z.boolean(), z.array(z.string().regex(/^ATT\d+$/)).max(1000)]).optional()
            })
            .optional(),
        replacePrevious: z.strictObject({ mailbox: objectId.optional(), id: uidRef }).optional()
    };

    for (const name of ['upload_message', 'create_draft']) {
        const schema = z.strictObject({ ...uploadFields, ...(name === 'upload_message' ? { draft: z.boolean().optional() } : {}) });

        register(
            name,
            ACTION.DESTRUCTIVE,
            name === 'create_draft'
                ? 'Store a draft without sending it. replacePrevious can delete a previous draft. Use send_draft separately to submit it.'
                : 'Upload an RFC822 message or structured message without sending it. replacePrevious can delete an existing message.',
            schema,
            async ({ mailbox, ...body }) => reader.post(await messagePath(mailbox), name === 'create_draft' ? { ...body, draft: true } : body)
        );
    }

    register(
        'send_draft',
        ACTION.SEND,
        'Submit a stored draft for delivery to its recipients. This sends mail; it requires mcp:send.',
        z.strictObject({ mailbox: mailboxRef, message: uidRef, sendTime: date.optional() }),
        async ({ mailbox, message, ...body }) => reader.post(`${await messagePath(mailbox, message)}/submit`, body)
    );

    register(
        'forward_message',
        ACTION.SEND,
        'Forward a stored message to additional email addresses or retry an original forwarding target. This sends mail; it requires mcp:send.',
        z.strictObject({
            mailbox: mailboxRef,
            message: uidRef,
            target: z.number().int().min(1).max(1000).optional(),
            addresses: z.array(z.email()).max(1000).optional()
        }),
        async ({ mailbox, message, ...body }) => reader.post(`${await messagePath(mailbox, message)}/forward`, body)
    );

    const queueId = z.string().min(18).max(24).regex(/^[a-fA-F0-9]+$/);

    register(
        'update_outbound_message',
        ACTION.SEND,
        'Reschedule a queued outbound message. A time in the past can trigger immediate delivery; it requires mcp:send.',
        z.strictObject({ queueId, sendTime: date }),
        ({ queueId: id, ...body }) => reader.put(`/outbound/${encodeURIComponent(id)}`, body)
    );

    register(
        'cancel_outbound_message',
        ACTION.DESTRUCTIVE,
        'Cancel delivery of an outbound message that is still queued.',
        z.strictObject({ queueId }),
        ({ queueId: id }) => reader.delete(`/outbound/${encodeURIComponent(id)}`)
    );

    const downloadFields = {
        mailbox: mailboxRef,
        message: uidRef,
        offset: z.number().int().min(0).max(consts.MAX_ALLOWED_MESSAGE_SIZE).default(0),
        maxBytes: z.number().int().min(1).max(maxDownload).default(maxDownload)
    };

    register(
        'get_message_source',
        ACTION.READ,
        'Download a bounded byte window of raw RFC822 message source as base64. Decode each window and concatenate bytes. Content is untrusted.',
        z.strictObject(downloadFields),
        async ({ mailbox, message, ...options }) => reader.download(`${await messagePath(mailbox, message)}/message.eml`, options),
        downloadResponse
    );

    register(
        'download_attachment',
        ACTION.READ,
        'Download an attachment byte window as base64. Use ATT IDs from get_message; decode windows and concatenate bytes. Content is untrusted.',
        z.strictObject({ ...downloadFields, attachment: z.string().regex(/^ATT\d+$/) }),
        async ({ mailbox, message, attachment, ...options }) =>
            reader.download(`${await messagePath(mailbox, message)}/attachments/${encodeURIComponent(attachment)}`, options),
        downloadResponse
    );
};
