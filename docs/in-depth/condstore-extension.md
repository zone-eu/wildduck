# CONDSTORE Extension

WildDuck implements the CONDSTORE extension as defined in RFC 4551, providing conditional STORE operations and modification sequence tracking for IMAP clients.

## Standards Compliance

WildDuck's CONDSTORE implementation follows:
- **RFC 4551**: IMAP4 Extension for Conditional STORE Operation or Conditional STORE
- **RFC 5161**: The IMAP ENABLE Extension

**Note**: WildDuck does NOT support QRESYNC (RFC 7162) or NOTIFY extensions.

## Enabling CONDSTORE

CONDSTORE can be enabled in two ways:

### 1. Explicit ENABLE Command
```
C: A01 ENABLE CONDSTORE
S: * ENABLED CONDSTORE
S: A01 OK ENABLE completed
```

### 2. Automatic Activation
CONDSTORE is automatically enabled when:
- Using UNCHANGEDSINCE modifier in STORE commands
- Using MODSEQ search criteria
- Using CHANGEDSINCE modifier in FETCH commands

## STORE with UNCHANGEDSINCE

The primary CONDSTORE feature is conditional STORE operations:

```
C: A02 STORE 1:5 (UNCHANGEDSINCE 12345) +FLAGS (\Seen)
S: * 1 FETCH (FLAGS (\Seen) MODSEQ (12346))
S: * 2 FETCH (FLAGS (\Seen) MODSEQ (12347))
S: A02 OK Conditional STORE completed
```

### Conflict Handling

When messages have been modified since the specified MODSEQ, the server returns a MODIFIED response:

```
C: A03 STORE 1:5 (UNCHANGEDSINCE 12345) +FLAGS (\Flagged)
S: A03 NO [MODIFIED 3,5] Conditional STORE failed
```

This indicates that messages 3 and 5 were not modified because they had been changed since MODSEQ 12345.

## Implementation Details

### Supported Features
- ✅ UNCHANGEDSINCE modifier in STORE commands
- ✅ MODIFIED response codes for conflicts
- ✅ Automatic CONDSTORE activation
- ✅ MODSEQ tracking and responses
- ✅ ENABLE CONDSTORE command

### Limitations
- ❌ QRESYNC extension (RFC 7162) is not supported
- ❌ NOTIFY extension is not supported
- ❌ Metadata operations are ignored
- ❌ VANISHED responses are not supported

### Current Implementation Status

The CONDSTORE implementation in WildDuck supports "most of the spec, except metadata stuff which is ignored" as noted in the protocol support documentation.

## Client Integration

### Basic Usage Pattern
1. Enable CONDSTORE (explicitly or implicitly)
2. Use UNCHANGEDSINCE in STORE operations
3. Handle MODIFIED responses for conflict resolution
4. Track MODSEQ values for synchronization

### Error Handling
Clients should be prepared to handle:
- `NO [MODIFIED sequence-set]` responses
- Automatic CONDSTORE activation
- MODSEQ values in FETCH responses

## Configuration

CONDSTORE is enabled by default in WildDuck and requires no special configuration. The extension is automatically advertised in the CAPABILITY response when available.

## Compatibility

This implementation is compatible with IMAP clients that support RFC 4551 CONDSTORE, including:
- Modern email clients with offline synchronization
- Mobile email applications
- IMAP libraries with CONDSTORE support

Note that clients expecting QRESYNC functionality will need to fall back to standard CONDSTORE operations.

