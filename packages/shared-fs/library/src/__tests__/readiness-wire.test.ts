import { field, serialize, variant } from "@dao-xyz/borsh";
import { RPC, type CodecErrorEvent } from "@peerbit/rpc";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    CELL_BYTES,
    LIST_PAGE_HASHES,
    M,
    MAX_ANSWER_BYTES,
    PUSH_MAX,
    READINESS_FORMAT_TAG,
} from "../readiness/constants.js";
import {
    CellsReqV1,
    CellsV1,
    CloseV1,
    ERROR_CODE,
    ErrorV1,
    HeaderV1,
    ListPageV1,
    ListV1,
    NOTICE_REASON,
    OPEN_FLAG_LIST,
    OpenScopeV1,
    OpenV1,
    ProvenanceV1,
    READINESS_CAPS,
    ReadinessMessage,
    StateNoticeV1,
    checkReadinessMessage,
    decodeReadinessMessage,
    encodeReadinessMessage,
} from "../readiness/wire.js";
import { stopTestPeers } from "./stop-test-peers.js";

const bytes = (n: number, start: number) =>
    Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

const sessionId = bytes(16, 0x10);
const logId = bytes(32, 0x40);
const provenance = () =>
    new ProvenanceV1({
        writeReady: true,
        source: "reconciled",
        fullReplica: true,
        phase: "converged",
        openNonce: bytes(16, 0x80),
        caps: 0x01020304,
    });

/** One fixed message per v1 variant; their bytes are pinned below. */
const fixtures = (): Record<string, ReadinessMessage> => ({
    OpenV1: new OpenV1({
        sessionId,
        attempt: 2,
        flags: OPEN_FLAG_LIST,
        caps: 0x0a0b0c0d,
        hlcProved: 0x0102030405060708n,
        scopes: [
            new OpenScopeV1({ scope: 0, logId, count: 0x11223344, above: 5 }),
            new OpenScopeV1({
                scope: 1,
                logId: bytes(32, 0x60),
                count: 7,
                above: 0,
            }),
        ],
    }),
    HeaderV1: new HeaderV1({
        sessionId,
        scope: 0,
        logId,
        provenance: provenance(),
        count: 1000,
        anchor: bytes(32, 0xc0),
        hlc: 1_800_000_000_123_456_789n,
        above: 3,
        cellsFrom: 8,
        cells: bytes(2 * CELL_BYTES, 0),
    }),
    CellsReqV1: new CellsReqV1({ sessionId, scope: 1, logId, from: 0, to: M }),
    CellsV1: new CellsV1({
        sessionId,
        scope: 0,
        logId,
        from: 16,
        cells: bytes(CELL_BYTES, 0x20),
    }),
    ListPageV1: new ListPageV1({ sessionId, scope: 0, logId, offset: 2048 }),
    ListV1: new ListV1({
        sessionId,
        scope: 0,
        logId,
        offset: 0,
        hashes: bytes(64, 0x30),
        done: true,
    }),
    CloseV1: new CloseV1({ sessionId }),
    ErrorV1: new ErrorV1({ sessionId, code: ERROR_CODE.EXPIRED }),
    StateNoticeV1: new StateNoticeV1({
        provenance: provenance(),
        reason: NOTICE_REASON.CAPACITY,
    }),
});

/**
 * Golden bytes of every v1 layout. Once a v9.2 build is released these must
 * never change: a new field is a new variant, sent only to peers whose caps
 * (`OpenV1.caps`, `ProvenanceV1.caps`) advertise it.
 */
const GOLDEN: Record<string, string> = {
    OpenV1:
        "0001101112131415161718191a1b1c1d1e1f02010d0c0b0a0807060504030201" +
        "0200404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d" +
        "5e5f443322110500000001606162636465666768696a6b6c6d6e6f7071727374" +
        "75767778797a7b7c7d7e7f0700000000000000",
    HeaderV1:
        "0101101112131415161718191a1b1c1d1e1f00404142434445464748494a4b4c" +
        "4d4e4f505152535455565758595a5b5c5d5e5f0e7368617265642d66732f7639" +
        "2e3201020103808182838485868788898a8b8c8d8e8f04030201e8030000c0c1" +
        "c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf15cd" +
        "0f9b76e2fa18030000000800000058000000000102030405060708090a0b0c0d" +
        "0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d" +
        "2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d" +
        "4e4f5051525354555657",
    CellsReqV1:
        "0201101112131415161718191a1b1c1d1e1f01404142434445464748494a4b4c" +
        "4d4e4f505152535455565758595a5b5c5d5e5f0000000000100000",
    CellsV1:
        "0301101112131415161718191a1b1c1d1e1f00404142434445464748494a4b4c" +
        "4d4e4f505152535455565758595a5b5c5d5e5f100000002c0000002021222324" +
        "25262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f4041424344" +
        "45464748494a4b",
    ListPageV1:
        "0401101112131415161718191a1b1c1d1e1f00404142434445464748494a4b4c" +
        "4d4e4f505152535455565758595a5b5c5d5e5f00080000",
    ListV1:
        "0501101112131415161718191a1b1c1d1e1f00404142434445464748494a4b4c" +
        "4d4e4f505152535455565758595a5b5c5d5e5f00000000400000003031323334" +
        "35363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f5051525354" +
        "55565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f01",
    CloseV1: "0601101112131415161718191a1b1c1d1e1f",
    ErrorV1: "0701101112131415161718191a1b1c1d1e1f02",
    StateNoticeV1:
        "08010e7368617265642d66732f76392e3201020103808182838485868788898a" +
        "8b8c8d8e8f0403020101",
};

const VARIANTS: Record<string, number> = {
    OpenV1: 0,
    HeaderV1: 1,
    CellsReqV1: 2,
    CellsV1: 3,
    ListPageV1: 4,
    ListV1: 5,
    CloseV1: 6,
    ErrorV1: 7,
    StateNoticeV1: 8,
};

/** Plain data of a decoded message, for deep comparison. */
const plain = (value: unknown): unknown => {
    if (value instanceof Uint8Array) return hex(value);
    if (Array.isArray(value)) return value.map(plain);
    if (value && typeof value === "object") {
        return {
            class: value.constructor.name,
            ...Object.fromEntries(
                Object.entries(value).map(([key, inner]) => [key, plain(inner)])
            ),
        };
    }
    return value;
};

describe("readiness wire v1", () => {
    it("round-trips every variant", () => {
        for (const [name, message] of Object.entries(fixtures())) {
            const encoded = encodeReadinessMessage(message);
            expect(encoded[0], name).toBe(VARIANTS[name]);
            const decoded = decodeReadinessMessage(encoded);
            expect(decoded.constructor.name).toBe(name);
            expect(plain(decoded)).toEqual(plain(message));
            expect(checkReadinessMessage(decoded), name).toBeUndefined();
        }
    });

    it("pins the golden bytes of every v1 layout", () => {
        const actual = Object.fromEntries(
            Object.entries(fixtures()).map(([name, message]) => [
                name,
                hex(encodeReadinessMessage(message)),
            ])
        );
        expect(actual).toEqual(GOLDEN);
    });

    it("carries the format tag and the caps field", () => {
        const fresh = new ProvenanceV1({
            writeReady: false,
            source: "none",
            fullReplica: false,
            phase: "off",
            openNonce: new Uint8Array(16),
        });
        expect(fresh.formatTag).toBe(READINESS_FORMAT_TAG);
        expect(fresh.caps).toBe(READINESS_CAPS);
        expect(READINESS_CAPS).toBe(0);
        // caps is the last provenance field: a little-endian u32.
        const encoded = serialize(provenance());
        expect(hex(encoded.subarray(encoded.length - 4))).toBe("04030201");
        // A joiner advertises its own caps in every OPEN.
        const open = new OpenV1({
            sessionId,
            attempt: 0,
            hlcProved: 0n,
            scopes: [],
        });
        expect(open.caps).toBe(READINESS_CAPS);
    });

    it("rejects a changed layout at decode, whatever its version byte", () => {
        // Borsh rejects trailing bytes: a version 2 that appends a field is
        // a codec error, never an UNSUPPORTED answer, so a layout change
        // must be a new variant.
        const open = fixtures().OpenV1 as OpenV1;
        open.version = 2;
        const extended = new Uint8Array([
            ...encodeReadinessMessage(open),
            1,
            2,
            3,
            4,
        ]);
        expect(() => decodeReadinessMessage(extended)).toThrow(/bytes after/);
        const close = encodeReadinessMessage(new CloseV1({ sessionId }));
        expect(() =>
            decodeReadinessMessage(new Uint8Array([...close, 0]))
        ).toThrow(/bytes after/);
    });

    it("bounds the fields decoded before the guard with u8 lengths", () => {
        const scope = new OpenScopeV1({ scope: 0, logId, count: 0, above: 0 });
        // At most 255 scopes fit the encoding. (The format tag is a
        // constant; borsh writes a longer u8-prefixed string truncated, so
        // only the decode side is pinned for it: below.)
        expect(() =>
            encodeReadinessMessage(
                new OpenV1({
                    sessionId,
                    attempt: 0,
                    hlcProved: 0n,
                    scopes: Array.from({ length: 256 }, () => scope),
                })
            )
        ).toThrow();
        // A tag length byte bounds what the decoder reads for it.
        const notice = encodeReadinessMessage(fixtures().StateNoticeV1);
        expect(notice[2]).toBe(READINESS_FORMAT_TAG.length);
        // A 10 MB message claiming 255 scopes fails at once on its rest.
        const big = new Uint8Array(10_000_000);
        big.set(
            encodeReadinessMessage(
                new OpenV1({
                    sessionId,
                    attempt: 0,
                    hlcProved: 0n,
                    scopes: [scope],
                })
            )
        );
        const started = performance.now();
        expect(() => decodeReadinessMessage(big)).toThrow();
        expect(performance.now() - started).toBeLessThan(50);
    });

    it("fails decode on an unknown variant or a truncated message", () => {
        expect(() => decodeReadinessMessage(Uint8Array.of(9, 1))).toThrow();
        expect(() => decodeReadinessMessage(Uint8Array.of(255))).toThrow();
        const close = encodeReadinessMessage(new CloseV1({ sessionId }));
        expect(() => decodeReadinessMessage(close.subarray(0, 10))).toThrow();
    });

    it("answers a known variant of another version with UNSUPPORTED", () => {
        const open = fixtures().OpenV1 as OpenV1;
        open.version = 2;
        expect(checkReadinessMessage(open)).toBe(ERROR_CODE.UNSUPPORTED);
        const header = fixtures().HeaderV1 as HeaderV1;
        header.version = 0;
        expect(checkReadinessMessage(header)).toBe(ERROR_CODE.UNSUPPORTED);
        // Without a session (a notice) or for an error, there is nothing to
        // answer: dropped.
        const notice = fixtures().StateNoticeV1 as StateNoticeV1;
        notice.version = 2;
        expect(checkReadinessMessage(notice)).toBe("drop");
        const error = fixtures().ErrorV1 as ErrorV1;
        error.version = 2;
        expect(checkReadinessMessage(error)).toBe("drop");
    });

    it("guards scopes, flags, ranges and sizes", () => {
        const open = (scopes: number[], flags = 0) =>
            new OpenV1({
                sessionId,
                attempt: 0,
                flags,
                hlcProved: 0n,
                scopes: scopes.map(
                    (scope) =>
                        new OpenScopeV1({ scope, logId, count: 0, above: 0 })
                ),
            });
        expect(checkReadinessMessage(open([0]))).toBeUndefined();
        expect(checkReadinessMessage(open([1, 0]))).toBeUndefined();
        expect(checkReadinessMessage(open([]))).toBe(ERROR_CODE.SCOPE);
        expect(checkReadinessMessage(open([0, 0]))).toBe(ERROR_CODE.SCOPE);
        expect(checkReadinessMessage(open([2]))).toBe(ERROR_CODE.SCOPE);
        expect(checkReadinessMessage(open([0, 1, 0]))).toBe(ERROR_CODE.SCOPE);
        expect(checkReadinessMessage(open([0], 0b10))).toBe(
            ERROR_CODE.UNSUPPORTED
        );

        const header = (
            cells: number,
            cellsFrom = 0,
            patch?: Partial<ProvenanceV1>
        ) =>
            new HeaderV1({
                sessionId,
                scope: 0,
                logId,
                provenance: Object.assign(provenance(), patch),
                count: 0,
                anchor: new Uint8Array(32),
                hlc: 0n,
                above: 0,
                cellsFrom,
                cells: new Uint8Array(cells),
            });
        expect(
            checkReadinessMessage(header(PUSH_MAX * CELL_BYTES))
        ).toBeUndefined();
        expect(checkReadinessMessage(header((PUSH_MAX + 1) * CELL_BYTES))).toBe(
            "drop"
        );
        expect(checkReadinessMessage(header(CELL_BYTES + 1))).toBe("drop");
        expect(
            checkReadinessMessage(header(CELL_BYTES, M - 1))
        ).toBeUndefined();
        expect(checkReadinessMessage(header(2 * CELL_BYTES, M - 1))).toBe(
            "drop"
        );
        expect(
            checkReadinessMessage(header(0, 0, { formatTag: "shared-fs/v9.1" }))
        ).toBe("drop");
        expect(checkReadinessMessage(header(0, 0, { source: 7 }))).toBe("drop");
        expect(checkReadinessMessage(header(0, 0, { phase: 5 }))).toBe("drop");
        const wrongScope = header(0);
        wrongScope.scope = 2;
        expect(checkReadinessMessage(wrongScope)).toBe("drop");

        const request = (from: number, to: number, scope = 0) =>
            new CellsReqV1({ sessionId, scope, logId, from, to });
        expect(checkReadinessMessage(request(0, M))).toBeUndefined();
        expect(checkReadinessMessage(request(0, M + 1))).toBe(ERROR_CODE.SCOPE);
        expect(checkReadinessMessage(request(5, 5))).toBe(ERROR_CODE.SCOPE);
        expect(checkReadinessMessage(request(0, 1, 2))).toBe(ERROR_CODE.SCOPE);
        expect(
            checkReadinessMessage(
                new ListPageV1({ sessionId, scope: 9, logId, offset: 0 })
            )
        ).toBe(ERROR_CODE.SCOPE);

        const cells = (n: number, from = 0) =>
            new CellsV1({
                sessionId,
                scope: 0,
                logId,
                from,
                cells: new Uint8Array(n),
            });
        expect(checkReadinessMessage(cells(M * CELL_BYTES))).toBeUndefined();
        expect(checkReadinessMessage(cells(M * CELL_BYTES, 1))).toBe("drop");
        expect(checkReadinessMessage(cells(CELL_BYTES - 1))).toBe("drop");

        const list = (n: number) =>
            new ListV1({
                sessionId,
                scope: 0,
                logId,
                offset: 0,
                hashes: new Uint8Array(n),
                done: false,
            });
        expect(
            checkReadinessMessage(list(LIST_PAGE_HASHES * 32))
        ).toBeUndefined();
        expect(checkReadinessMessage(list((LIST_PAGE_HASHES + 1) * 32))).toBe(
            "drop"
        );
        expect(checkReadinessMessage(list(33))).toBe("drop");

        expect(
            checkReadinessMessage(new ErrorV1({ sessionId, code: 4 as any }))
        ).toBe("drop");
        expect(
            checkReadinessMessage(
                new StateNoticeV1({ provenance: provenance(), reason: 3 })
            )
        ).toBe("drop");
    });

    it("keeps the largest answers under the answer cap", () => {
        const allCells = encodeReadinessMessage(
            new CellsV1({
                sessionId,
                scope: 0,
                logId,
                from: 0,
                cells: new Uint8Array(M * CELL_BYTES),
            })
        );
        expect(allCells.length).toBeLessThan(MAX_ANSWER_BYTES);
        const fullPage = encodeReadinessMessage(
            new ListV1({
                sessionId,
                scope: 0,
                logId,
                offset: 0,
                hashes: new Uint8Array(LIST_PAGE_HASHES * 32),
                done: true,
            })
        );
        expect(fullPage.length).toBeLessThanOrEqual(64 * 1024 + 60);
        const pushed = encodeReadinessMessage(
            new HeaderV1({
                sessionId,
                scope: 0,
                logId,
                provenance: provenance(),
                count: 0,
                anchor: new Uint8Array(32),
                hlc: 0n,
                above: 0,
                cells: new Uint8Array(PUSH_MAX * CELL_BYTES),
            })
        );
        expect(pushed.length).toBeLessThan(MAX_ANSWER_BYTES);
    });
});

/** A message from a later build: a variant this build does not know. */
abstract class LaterMessage {}
@variant(9)
class LaterV1 extends LaterMessage {
    @field({ type: "u8" })
    version = 1;
}

describe("readiness wire over the RPC", () => {
    const peers: Peerbit[] = [];
    afterEach(() => stopTestPeers(peers));

    it("drops an unknown variant as a codec error and delivers known ones", async () => {
        const [receiver, sender] = await Promise.all([
            Peerbit.create(),
            Peerbit.create(),
        ]);
        peers.push(receiver, sender);
        await sender.dial(receiver);
        const topic = "shared-fs-readiness-wire-test";
        const received: ReadinessMessage[] = [];
        const codecErrors: CodecErrorEvent[] = [];
        const inbox = await receiver.open(
            new RPC<ReadinessMessage, ReadinessMessage>(),
            {
                args: {
                    topic,
                    queryType: ReadinessMessage,
                    responseType: ReadinessMessage,
                    responseHandler: (message) => {
                        received.push(message);
                        return undefined;
                    },
                },
            }
        );
        inbox.events.addEventListener("codecError", (event) =>
            codecErrors.push(event.detail)
        );
        const outbox = await sender.open(new RPC<any, ReadinessMessage>(), {
            args: {
                topic,
                queryType: ReadinessMessage,
                responseType: ReadinessMessage,
            },
        });
        await outbox.waitFor(receiver.identity.publicKey);
        const to = [receiver.identity.publicKey];
        await outbox.send(new LaterV1(), { to });
        await outbox.send(new CloseV1({ sessionId }), { to });
        const deadline = Date.now() + 30_000;
        while (
            (received.length < 1 || codecErrors.length < 1) &&
            Date.now() < deadline
        ) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(received.map((message) => message.constructor.name)).toEqual([
            "CloseV1",
        ]);
        expect(codecErrors.map((error) => error.stage)).toEqual([
            "decode-request",
        ]);
    });
});
