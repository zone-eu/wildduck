'use strict';

module.exports = {
    SCHEMA_VERSION: '1.0',

    // how many modifications to cache before writing
    BULK_BATCH_SIZE: 150,

    // how often to clear expired messages
    GC_INTERVAL: 15 * 60 * 1000,

    // artificail delay between deleting next expired message in ms
    // set to 0 to disable
    GC_DELAY_DELETE: 0,

    // default
    MAX_STORAGE: 1 * (1024 * 1024 * 1024),
    MAX_RECIPIENTS: 2000,
    MAX_FORWARDS: 2000,

    MAX_RCPT_TO: 400,

    JUNK_RETENTION: 30 * 24 * 3600 * 1000,

    // how long to keep messages of deleted users before deleting
    DELETED_USER_MESSAGE_RETENTION: 14 * 24 * 3600 * 1000,

    MAILBOX_COUNTER_TTL: 24 * 3600,

    // how much plaintext to store in a full text indexed field
    MAX_PLAINTEXT_INDEXED: 1 * 1024,

    // how much plaintext to store before truncating
    MAX_PLAINTEXT_CONTENT: 100 * 1024,

    // how much HTML content to store before truncating. not indexed
    MAX_HTML_CONTENT: 640 * 1024,

    MAX_AUTOREPLY_INTERVAL: 4 * 3600 * 1000,

    MAX_AUTOREPLIES: 2000,

    DEFAULT_HASH_ALGO: 'pbkdf2', //either 'pbkdf2' or 'bcrypt'

    BCRYPT_ROUNDS: 11, // bcrypt.js benchmark async in a VPS: 261.192ms, do not want to take it too long
    PDKDF2_ITERATIONS: 100000,
    PDKDF2_SALT_SIZE: 16,
    PDKDF2_DIGEST: 'sha256', // 'sha512', 'sha256' or 'sha1'

    // how many authentication failures per user to allow before blocking until the end of the auth window
    USER_AUTH_FAILURES: 12,
    // authentication window in seconds, starts counting from first invalid authentication
    USER_AUTH_WINDOW: 120,

    // how many authentication failures per ip to allow before blocking until the end of the auth window
    //IP_AUTH_FAILURES: 10,
    IP_AUTH_FAILURES: 0, // disable IP rate limiting for now as too many false positives occurred while scanners use unique IPs
    // authentication window in seconds, starts counting from first invalid authentication
    IP_AUTH_WINDOW: 300,

    // how many TOTP failures per user to allow before blocking until the end of the auth window
    TOTP_FAILURES: 6,
    // TOTP authentication window in seconds, starts counting from first invalid authentication
    TOTP_WINDOW: 180,

    SCOPES: ['imap', 'pop3', 'smtp'],

    // Refuse to process messages larger than 64 MB. Allowing larger messages might cause jumbo chunks in MongoDB
    MAX_ALLOWED_MESSAGE_SIZE: 64 * 1024 * 1024,

    // Refuse to process attachments larger than 64 MB
    MAX_ALLOWED_ATTACHMENT_SIZE: 25 * 1024 * 1024,

    // how long to keep deleted messages around before purgeing
    ARCHIVE_TIME: 25 * 24 * 3600 * 1000,

    // merge similar authlog events into 6 hour buckets instead of storing each separately
    // this is mostly needed for IMAP clients that make crazy amount of connections and thus logins
    AUTHLOG_BUCKET: 6 * 3600 * 1000,
    AUTHLOG_TIME: 30 * 24 * 3600 * 1000,

    // start processing tasks 5 minutes after startup
    TASK_STARTUP_INTERVAL: 1 * 60 * 1000,

    // if no tasks were found, wait 2 seconds
    TASK_IDLE_INTERVAL: 2 * 1000,

    TASK_LOCK_INTERVAL: 1 * 3600 * 1000,

    // unlock pending tasks in every 5 minutes
    TASK_RELEASE_DELAYED_INTERVAL: 5 * 60 * 1000,

    // renewal interval, must be lower than TASK_LOCK_INTERVAL
    TASK_UPDATE_INTERVAL: 10 * 60 * 1000,

    TEMP_PASS_WINDOW: 24 * 3600 * 1000,

    // mongdb query TTL limits
    DB_MAX_TIME_USERS: 3 * 1000,
    DB_MAX_TIME_MAILBOXES: 3 * 1000,
    DB_MAX_TIME_MESSAGES: 2 * 60 * 1000,
    DB_MAX_TIME_MESSAGES_SEARCH: 3 * 1000, // 3 seconds for user search

    // what is the max username part after wildcard
    MAX_ALLOWED_WILDCARD_LENGTH: 32,

    // access token default ttl in seconds (token ttl time is extended every time token is used by this value)
    ACCESS_TOKEN_DEFAULT_TTL: 14 * 24 * 3600,
    // access token can be extended until max lifetime value is reached in seconds
    ACCESS_TOKEN_MAX_LIFETIME: 180 * 24 * 3600,

    TOTP_WINDOW_SIZE: 6,

    // how often to send processing updates for long running commands
    LONG_COMMAND_NOTIFY_TTL: 1 * 60 * 1000,

    // when paging through a large list, how many entries to request per page
    CURSOR_MAX_PAGE_SIZE: 2500,

    // challenge timeout in seconds
    WEBAUTHN_CHALLENGE_TTL: 1 * 60 * 60,

    // Default maximum application password limit
    // Outlook limits to 40
    // https://support.microsoft.com/en-gb/account-billing/manage-app-passwords-for-two-step-verification-d6dc8c6d-4bf7-4851-ad95-6d07799387e9
    MAX_ASP_COUNT: 50,

    // default max IMAP download size
    MAX_IMAP_DOWNLOAD: 10 * 1024 * 1024 * 1024,

    // default max POP3 download size
    MAX_POP3_DOWNLOAD: 10 * 1024 * 1024 * 1024,

    // default max IMAP upload size
    MAX_IMAP_UPLOAD: 10 * 1024 * 1024 * 1024,

    // maximum number of filters per account
    MAX_FILTERS: 400,

    // maximum amount of mailboxes per user
    MAX_MAILBOXES: 1500,

    // Max length of a mailbox subpath element
    MAX_MAILBOX_NAME_LENGTH: 512,

    // Number of mailbox subpaths in a single mailbox path
    MAX_SUB_MAILBOXES: 128
};
