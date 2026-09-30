# Peerbit shared-fs IPC protocol v2

Status: implemented by the Node server and Go native adapter; v2 is the only
supported protocol. The base64 JSONL protocol v1 is retired: servers and
adapters no longer speak it, and adapters or CLIs from 0.13.15 or earlier
(which speak only v1) are unsupported. Implementations MUST NOT send a v2
binary frame until the negotiation below has succeeded.

Only an adapter from the same release as the CLI is supported. `peerbit-fs
mount` refuses a managed adapter whose install record does not pin it to the
CLI's own release (`shared-fs-native-v<cli version>`), and
`peerbit-fs install-adapter --force` installs the matching adapter. Adapters
passed explicitly with `--native-adapter` or `PEERBIT_SHARED_FS_NATIVE_ADAPTER`
are not checked by the CLI. The negotiation below gates a v2-capable adapter:
one from before the offer carried a token fails at mount startup, because the
server refuses its offer (see Authentication). A v1-only adapter never
negotiates, so it still mounts, and the server rejects each connection's first
operation as described below.

The normative terms MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are
to be interpreted as described by RFC 2119 and RFC 8174.

## Goals and scope

V2 carries file payloads as raw frame bodies, without base64 expansion or
redundant copies, while retaining bounded memory use and request ordering. It
is a local transport protocol. It authenticates each connection with a secret
token of the server; it does not provide authorization, encryption,
compression, or an application checksum. Those properties remain the
responsibility of the endpoint and the underlying transport.

All lengths in this document are encoded-byte lengths, never JavaScript string
lengths or Unicode code-point counts. A transport chunk has no protocol
meaning: implementations MUST handle headers, metadata, bodies, and UTF-8 code
units split or coalesced at arbitrary byte boundaries.

## Negotiation

Negotiation begins on a fresh connection with one JSONL handshake line: UTF-8
JSON followed by one LF byte. The client sends exactly one non-mutating
request using the reserved operation `$peerbit.shared-fs.ipc.negotiate`:

```json
{
    "id": 1,
    "op": "$peerbit.shared-fs.ipc.negotiate",
    "args": [
        {
            "protocol": "peerbit-shared-fs-ipc",
            "versions": [2],
            "nonce": "AAAAAAAAAAAAAAAAAAAAAA",
            "token": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "maxRequestFrameBytes": 67108864,
            "maxResponseFrameBytes": 67108864
        }
    ]
}
```

The actual message has one trailing LF byte. `versions` is ordered by client
preference. The nonce MUST be newly and unpredictably generated for each
connection and MUST be compared as an opaque string. `token` is the server's
secret (see Authentication). The literal nonce and token above are only
deterministic golden-vector values.

Each negotiation request and acknowledgement is limited to 65,536 encoded
UTF-8 bytes, excluding its trailing LF, independent of any configured frame
limit. The directional limits in the offer and acknowledgement apply to binary
frames, not to the handshake itself.

The server responds with one JSONL handshake line that echoes the request ID,
protocol, and nonce:

```json
{
    "id": 1,
    "ok": true,
    "result": {
        "protocol": "peerbit-shared-fs-ipc",
        "version": 2,
        "nonce": "AAAAAAAAAAAAAAAAAAAAAA",
        "maxRequestFrameBytes": 67108864,
        "maxResponseFrameBytes": 67108864,
        "maxMetadataBytes": 1048576
    }
}
```

The selected version MUST have appeared in the offer, and version 2 is the
only version a server may select. The returned limits are the effective
per-direction limits for the connection and MUST NOT exceed the corresponding
offered limits. A client MUST reject a malformed response, a mismatched
ID/protocol/nonce, a version other than 2, or invalid limits. Neither side may
send binary bytes before a valid acknowledgement has been fully received.

Every offered version MUST be an integer from 1 through 255, and an offer MUST
NOT contain duplicates. Clients offer exactly `[2]`; a server selects 2 from any
offer that contains it, whatever its position, and MUST NOT select a retired
version. V2 request and response frame limits MUST be integers from 1 through
4,294,967,295; the metadata limit MUST be an integer in the same range and MUST
NOT exceed either directional frame limit. An offer containing version 2 MUST
include both directional frame limits, and all three returned limits are
REQUIRED. Receivers MAY ignore otherwise unknown negotiation object members for
forward-compatible extensions.

A server MUST answer an authenticated offer without version 2 with an
`EPROTONOSUPPORT` error response and close the connection. A client MUST fail
closed when the server rejects the offer or closes the connection before
acknowledging it: it MUST NOT reconnect with another protocol, and it reports
the negotiation failure instead. Once any filesystem operation bytes have been
sent, the client MUST NOT retry or replay that operation automatically; the
outcome may be unknown. Transport errors after negotiation therefore fail the
operation closed.

A first line that is a JSON object but not a negotiation request, such as an
ordinary operation from a retired v1 client, MUST NOT be dispatched. The server answers
it with one JSONL `EPROTONOSUPPORT` error response that echoes its request ID
when that ID is a non-negative safe integer (otherwise 0) and explains that the
adapter must be replaced, then closes the connection. Any other malformed
first line closes the connection without a response. No binary sniffing is
permitted before negotiation.

## Authentication

Every connection authenticates with the server's token, on every transport,
including a Unix socket in an owner-only directory. The server generates the
token when it starts, from a cryptographically secure random source, with at
least 128 bits of entropy; the Node server uses 32 bytes, base64url-encoded
without padding. Whoever starts the adapter hands it the token where other
local users cannot read it: `peerbit-fs mount` sets
`PEERBIT_SHARED_FS_IPC_TOKEN` in the adapter's environment, never an argument,
since other users can list a process's arguments. The client MUST send the
token unchanged as the `token` string of its offer.

The server MUST compare the presented token as an opaque string, in time that
does not depend on its own token; the Node server compares SHA-256 digests with
a constant-time comparison. It MUST answer an offer whose `token` is missing,
not a string, or different with an `EACCES` error response and close the
connection, before it selects a version or dispatches any operation. The
response MUST NOT contain either token. A client MUST treat the rejection like
any other rejected offer: it fails closed and does not reconnect.

The token is sent as is, not bound to the nonce: the client picks the nonce,
so it gives the server no freshness. The token authenticates the adapter to
the server, not the server to the adapter. It keeps out local users who can
connect to the endpoint but cannot read the adapter's environment, which only
the same user or an administrator can.

The protocol does not defend against a local user who can capture loopback
traffic, for example a non-administrator on Windows when Npcap was installed
without its administrators-only restriction, or a member of a group granted
BPF access on macOS. The token and all file data cross the connection in
plaintext, so such a user can read files as they pass and present the token,
which stays valid until the server closes. Binding the token to a server
challenge would not close this either: the same capture access often also
allows injecting into an established connection.

## Binary frame

After successful negotiation, every request and response is one binary frame:

| Offset |            Size | Field           | Encoding                         |
| -----: | --------------: | --------------- | -------------------------------- |
|      0 |               4 | magic           | ASCII `PBFS` (`50 42 46 53`)     |
|      4 |               1 | version         | unsigned integer, exactly `2`    |
|      5 |               1 | kind            | `1` request, `2` response        |
|      6 |               2 | flags           | unsigned big-endian, exactly `0` |
|      8 |               4 | metadata length | unsigned big-endian              |
|     12 |               4 | body length     | unsigned big-endian              |
|     16 | metadata length | metadata        | compact UTF-8 JSON               |
|    ... |     body length | body            | opaque bytes                     |

The fixed header is 16 bytes. Receivers MUST validate magic, version, kind,
flags, both individual lengths, and their overflow-safe sum before allocating
or reading the variable sections. The header is excluded from negotiated frame
limits. Metadata plus body MUST NOT exceed the effective directional frame
limit. Metadata MUST NOT exceed `maxMetadataBytes`, whose initial protocol
default and maximum is 1,048,576 bytes. The initial default directional frame
limit is 67,108,864 bytes. A zero-length body is valid. Unknown flags or kinds
MUST fail the connection closed.

Metadata MUST be valid shortest-form UTF-8 and valid JSON. It uses the JSON
request or response envelope of the handshake (`id`, `op`, `args` for
requests; `id`, `ok`, and `result` or `error` for responses), with
non-negative safe-integer IDs. Senders MUST
emit compact JSON with unique object member names. Receivers MUST validate the
decoded envelope and MAY reject duplicate member names; a decoder that
collapses duplicates is not required to add a separate duplicate detector.
Receivers MUST decode and validate the entire frame before dispatching an
operation.

For a `write` request, the byte argument in metadata is exactly
`{"$bytes":null}` and the raw bytes are the frame body. For a successful `read`
response, `result` is exactly `{"$bytes":null}` and the raw result is the body.
All other requests, all other successful responses, and every error response
MUST have a zero-length body. A bytes sentinel in any other position, a missing
sentinel when a body is required, or a non-empty unexpected body is a protocol
error. Base64 byte objects (`{"$bytes":"<base64>"}`) are not part of v2.

## Ordering, flow control, and failure semantics

Frame parsing on each byte stream is strictly serial. Once a complete request
has been decoded and validated, a server MAY dispatch independent requests
concurrently and MAY return their responses out of request order. Request IDs
MUST be unique among outstanding requests and MUST NOT be reused until the
matching response arrives or the connection closes. A server MUST reject a
duplicate outstanding ID, and a client MUST reject an unknown or duplicate
response ID. Implementations that do not multiplex MAY continue to dispatch
and respond serially.

The protocol does not infer filesystem-operation dependencies. A client MUST
await completion of an operation before sending another operation that depends
on its result or ordering; only independent operations may be outstanding
together.

All frame writes on a connection MUST pass through one atomic serialization
point so bytes from different headers, metadata sections, and bodies never
interleave. Writers MUST honor socket backpressure. Each endpoint MUST enforce
finite limits on both the count and aggregate bytes of outstanding frames,
including decoded operations and response bytes queued for writing. At a read
limit the endpoint pauses before parsing another frame, allowing transport
backpressure to propagate; it MUST NOT accumulate an unbounded frame or work
queue. Implementations MAY configure stricter limits or lower concurrency than
their peer.

Connection closure or cancellation MUST unblock outstanding reads, writes, and
request waiters.

Malformed input, premature EOF, an exceeded bound, or an invalid envelope
closes the connection without dispatching that frame or any coalesced later
frame. A decoded filesystem operation is dispatched at most once. Neither side
may infer that a mutation failed merely because its response was lost, and no
layer may transparently replay it.

## Platform requirements

The byte format is identical over TCP, Unix-domain sockets, and Windows named
pipes. Multi-byte integers are always unsigned big-endian. Implementations MUST
not depend on message boundaries, host endianness, path separators, or text
mode. A parsed 32-bit length must be range-checked, combined without overflow,
and checked against negotiated limits before conversion to a host allocation
size.

## Golden vectors

[`protocol/ipc-v2-vectors.json`](protocol/ipc-v2-vectors.json) is normative.
Its lowercase hexadecimal strings are byte-exact valid examples of complete
frames (or complete JSONL handshake lines, including LF). Every v2 decoder MUST
accept them and recover the recorded fields and bodies. JSON member order and
escaping are not canonical, so conforming encoders need not reproduce these
exact bytes unless a future protocol revision defines canonical JSON. Node and
Go protocol tests MUST consume this shared vector file rather than maintaining
separate copies.
