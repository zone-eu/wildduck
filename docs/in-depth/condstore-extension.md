# CONDSTORE Extension

WildDuck implements the CONDSTORE extension as defined in RFC 4551, providing conditional STORE operations and modification sequence tracking for IMAP clients.

## Available Commands

WildDuck supports these CONDSTORE commands:
- `ENABLE CONDSTORE` - Explicitly enable CONDSTORE
- `STORE ... (UNCHANGEDSINCE modseq)` - Conditional STORE operations
- `FETCH ... (CHANGEDSINCE modseq)` - Fetch messages changed since modseq
- `SEARCH MODSEQ` - Search by modification sequence

## Enabling CONDSTORE

CONDSTORE can be enabled explicitly:
```
C: A01 ENABLE CONDSTORE
S: * ENABLED CONDSTORE
S: A01 OK ENABLE completed
```

Or automatically when using UNCHANGEDSINCE, MODSEQ, or CHANGEDSINCE modifiers.

## Basic Usage

Conditional STORE operations:
```
C: A02 STORE 1:5 (UNCHANGEDSINCE 12345) +FLAGS (\Seen)
S: * 1 FETCH (FLAGS (\Seen) MODSEQ (12346))
S: A02 OK Conditional STORE completed
```

Conflict handling:
```
C: A03 STORE 1:5 (UNCHANGEDSINCE 12345) +FLAGS (\Flagged)
S: A03 NO [MODIFIED 3,5] Conditional STORE failed
```

## Limitations

- QRESYNC extension (RFC 7162) is not supported
- NOTIFY extension is not supported
- VANISHED responses are not supported
- Metadata operations are ignored

## Configuration

CONDSTORE is enabled by default and requires no special configuration.

