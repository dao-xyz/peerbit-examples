# Peerbit shared-fs IPC protocol v2

Status: implemented by the Node server and Go native adapter. The Go adapter
prefers v2 and safely falls back to v1 when an older server rejects or closes
during the non-mutating negotiation. The Node server continues to accept old
v1 clients. Implementations MUST NOT send a v2 binary frame until the
negotiation below has succeeded.

The normative terms MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are
to be interpreted as described by RFC 2119 and RFC 8174.

## Goals and scope

V2 removes v1's base64 expansion and redundant copies for file payloads while
retaining bounded memory use, request ordering, and interoperability with
deployed v1 adapters. It is a local transport protocol; it does not provide
authentication, authorization, encryption, compression, or an application
checksum. Those properties remain the responsibility of the endpoint and the
underlying transport.

All lengths in this document are encoded-byte lengths, never JavaScript string
lengths or Unicode code-point counts. A transport chunk has no protocol
meaning: implementations MUST handle headers, metadata, bodies, and UTF-8 code
units split or coalesced at arbitrary byte boundaries.

## Backward-compatible negotiation

Negotiation begins on a fresh connection in v1 JSONL. The client sends exactly
one non-mutating request using the reserved operation
`$peerbit.shared-fs.ipc.negotiate`:

```json
{
    "id": 1,
    "op": "$peerbit.shared-fs.ipc.negotiate",
    "args": [
        {
            "protocol": "peerbit-shared-fs-ipc",
            "versions": [2, 1],
            "nonce": "AAAAAAAAAAAAAAAAAAAAAA",
            "maxRequestFrameBytes": 67108864,
            "maxResponseFrameBytes": 67108864
        }
    ]
}
```

The actual message has one trailing LF byte. `versions` is ordered by client
preference. The nonce MUST be newly and unpredictably generated for each
connection and MUST be compared as an opaque string. The literal nonce above
is only a deterministic golden-vector value.

Each negotiation request and acknowledgement is limited to 65,536 encoded
UTF-8 bytes, excluding its trailing LF. A server MAY apply its configured v1
request bound while reading the initial offer. A client whose configured
request bound cannot hold its negotiation offer MAY begin the untouched
connection directly in v1. The directional limits in the offer and
acknowledgement apply to binary frames, not to the handshake itself.

A v2-capable server responds in v1 JSONL and echoes the request ID, protocol,
and nonce:

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

The selected version MUST have appeared in the offer. The returned limits are
the effective per-direction limits for the connection and MUST NOT exceed the
corresponding offered limits. A client MUST reject a malformed response, a
mismatched ID/protocol/nonce, an unoffered version, or invalid limits. Neither
side may send binary bytes before a valid version-2 acknowledgement has been
fully received. If version 1 is selected, both sides remain in v1 JSONL on that
connection.

Every offered version and the selected version MUST be an integer from 1
through 255, and an offer MUST NOT contain duplicates. V2 request and response
frame limits MUST be integers from 1 through 4,294,967,295; the metadata limit
MUST be an integer in the same range and MUST NOT exceed either directional
frame limit. An offer containing version 2 MUST include both directional frame
limits. The three returned limits are REQUIRED when version 2 is selected. When
version 1 is selected they MUST be absent and each endpoint retains its locally
configured v1 JSONL bounds. Receivers MAY ignore otherwise unknown negotiation
object members for forward-compatible extensions.

An old server will reject the reserved operation or close the connection. The
client MAY reconnect once and use v1 because the negotiation request cannot
mutate filesystem state. It MUST NOT put a v1 request on a connection that may
have switched to v2. Once any filesystem operation bytes have been sent, the
client MUST NOT fall back, retry, or replay that operation automatically; the
outcome may be unknown. Transport errors after negotiation therefore fail the
operation closed.

Old clients send ordinary v1 operations immediately and remain supported by a
dual-protocol server. A server distinguishes them by parsing the first v1 JSONL
operation; an ordinary operation pins that connection to v1 and negotiation is
thereafter invalid. No binary sniffing is permitted before negotiation.

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

Metadata MUST be valid shortest-form UTF-8 and valid JSON. It uses the v1
request or response envelope, with non-negative safe-integer IDs. Senders MUST
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
error. Nested v1 base64 byte objects are not supported in v2.

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
frames (or complete v1 negotiation lines, including LF). Every v2 decoder MUST
accept them and recover the recorded fields and bodies. JSON member order and
escaping are not canonical, so conforming encoders need not reproduce these
exact bytes unless a future protocol revision defines canonical JSON. Node and
Go protocol tests MUST consume this shared vector file when their v2 runtimes
are implemented rather than maintaining separate copies.
