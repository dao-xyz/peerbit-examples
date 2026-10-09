import {
    deserialize,
    field,
    fixedArray,
    serialize,
    string,
    variant,
    vec,
} from "@dao-xyz/borsh";
import {
    CELL_BYTES,
    DIGEST_BYTES,
    LIST_PAGE_HASHES,
    M,
    MAX_OPEN_SCOPES,
    PUSH_MAX,
    READINESS_FORMAT_TAG,
} from "./constants.js";
import { isScopeId } from "./scopes.js";

/**
 * Readiness wire, version 1 (WRITE_READINESS_V2.md section 4.3, M1 plan
 * section 5). One-way messages over the filesystem's `readiness` RPC, each
 * sent with `rpc.send(message, { to: [peer] })`.
 *
 * Every v1 layout is frozen once a v9.2 build is released: golden bytes in
 * `readiness-wire.test.ts` pin each one. Release hold (M1 plan section 0,
 * S3): do not merge a `Version Packages` PR until PR-3 lands; until then
 * the v1 wire is still open to fixes.
 *
 * An unknown variant fails Borsh decode inside the RPC and is dropped
 * (`codecError`), so the sender sees a reachable, silent peer. Borsh also
 * rejects trailing bytes, so a known variant with a changed or extended
 * layout fails decode the same way, whatever its version byte says. Every
 * layout change is therefore a new variant, sent only to a peer whose caps
 * advertise it: `OpenV1.caps` for what a joiner understands,
 * `ProvenanceV1.caps` for what a responder answers. A new error code or
 * notice reason is gated the same way (older guards drop it). `UNSUPPORTED`
 * answers only a version bump that kept the v1 layout.
 *
 * Variable-length fields a receiver decodes before the guard runs carry a
 * u8 length (`scopes`, `formatTag`), so the encoding itself bounds them.
 */

export const READINESS_WIRE_VERSION = 1;
export const SESSION_ID_BYTES = 16;
export const OPEN_NONCE_BYTES = 16;
export const LOG_ID_BYTES = 32;

/**
 * Bits of `OpenV1.caps` and `ProvenanceV1.caps`: optional variants, codes
 * and reasons a build understands. None yet.
 */
export const READINESS_CAPS = 0;

/** `OpenV1.flags` bit 0: freeze the snapshot's hash list (list mode). */
export const OPEN_FLAG_LIST = 1;
const OPEN_FLAGS_KNOWN = OPEN_FLAG_LIST;

export const ERROR_CODE = {
    BUSY: 0,
    UNSUPPORTED: 1,
    EXPIRED: 2,
    SCOPE: 3,
} as const;
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

export const NOTICE_REASON = {
    READY: 0,
    CAPACITY: 1,
    /** Reserved for M2. */
    WARM_FRESH: 2,
} as const;

/** `ProvenanceV1.source`, by code. */
export const PROVENANCE_SOURCES = [
    "none",
    "creator",
    "reconciled",
    "warm",
    "warm-fresh",
    "operator",
    "partial-override",
] as const;
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

/** `ProvenanceV1.phase`, by code (the bootstrap phases). */
export const PROVENANCE_PHASES = [
    "off",
    "fetching",
    "overlay-active",
    "converged",
    "unverified",
] as const;
export type ProvenancePhase = (typeof PROVENANCE_PHASES)[number];

export class ProvenanceV1 {
    @field({ type: string("u8") })
    formatTag: string;

    @field({ type: "bool" })
    writeReady: boolean;

    @field({ type: "u8" })
    source: number;

    @field({ type: "bool" })
    fullReplica: boolean;

    @field({ type: "u8" })
    phase: number;

    @field({ type: fixedArray("u8", OPEN_NONCE_BYTES) })
    openNonce: Uint8Array;

    /** u32 bitmask of the optional variants this build answers. */
    @field({ type: "u32" })
    caps: number;

    constructor(properties?: {
        formatTag?: string;
        writeReady: boolean;
        source: ProvenanceSource;
        fullReplica: boolean;
        phase: ProvenancePhase;
        openNonce: Uint8Array;
        caps?: number;
    }) {
        if (properties) {
            this.formatTag = properties.formatTag ?? READINESS_FORMAT_TAG;
            this.writeReady = properties.writeReady;
            this.source = PROVENANCE_SOURCES.indexOf(properties.source);
            this.fullReplica = properties.fullReplica;
            this.phase = PROVENANCE_PHASES.indexOf(properties.phase);
            this.openNonce = properties.openNonce;
            this.caps = properties.caps ?? READINESS_CAPS;
        }
    }
}

export abstract class ReadinessMessage {}

export class OpenScopeV1 {
    @field({ type: "u8" })
    scope: number;

    @field({ type: fixedArray("u8", LOG_ID_BYTES) })
    logId: Uint8Array;

    /** The joiner's live row count in this scope. */
    @field({ type: "u32" })
    count: number;

    /** The joiner's rows newer than `OpenV1.hlcProved`. */
    @field({ type: "u32" })
    above: number;

    constructor(properties?: {
        scope: number;
        logId: Uint8Array;
        count: number;
        above: number;
    }) {
        if (properties) {
            this.scope = properties.scope;
            this.logId = properties.logId;
            this.count = properties.count;
            this.above = properties.above;
        }
    }
}

@variant(0)
export class OpenV1 extends ReadinessMessage {
    @field({ type: "u8" })
    version: number;

    @field({ type: fixedArray("u8", SESSION_ID_BYTES) })
    sessionId: Uint8Array;

    @field({ type: "u8" })
    attempt: number;

    @field({ type: "u8" })
    flags: number;

    /** u32 bitmask of the optional variants this joiner understands. */
    @field({ type: "u32" })
    caps: number;

    @field({ type: "u64" })
    hlcProved: bigint;

    @field({ type: vec(OpenScopeV1, "u8") })
    scopes: OpenScopeV1[];

    constructor(properties?: {
        version?: number;
        sessionId: Uint8Array;
        attempt: number;
        flags?: number;
        caps?: number;
        hlcProved: bigint;
        scopes: OpenScopeV1[];
    }) {
        super();
        if (properties) {
            this.version = properties.version ?? READINESS_WIRE_VERSION;
            this.sessionId = properties.sessionId;
            this.attempt = properties.attempt;
            this.flags = properties.flags ?? 0;
            this.caps = properties.caps ?? READINESS_CAPS;
            this.hlcProved = properties.hlcProved;
            this.scopes = properties.scopes;
        }
    }
}

@variant(1)
export class HeaderV1 extends ReadinessMessage {
    @field({ type: "u8" })
    version: number;

    @field({ type: fixedArray("u8", SESSION_ID_BYTES) })
    sessionId: Uint8Array;

    @field({ type: "u8" })
    scope: number;

    @field({ type: fixedArray("u8", LOG_ID_BYTES) })
    logId: Uint8Array;

    @field({ type: ProvenanceV1 })
    provenance: ProvenanceV1;

    @field({ type: "u32" })
    count: number;

    /** D_R: sha256 of the snapshot's anchor lanes. */
    @field({ type: fixedArray("u8", 32) })
    anchor: Uint8Array;

    /** Highest `__context.modified` (u64 ns) in the snapshot. */
    @field({ type: "u64" })
    hlc: bigint;

    @field({ type: "u32" })
    above: number;

    @field({ type: "u32" })
    cellsFrom: number;

    /** Pushed cells, 44 B each, at most PUSH_MAX. */
    @field({ type: Uint8Array })
    cells: Uint8Array;

    constructor(properties?: {
        version?: number;
        sessionId: Uint8Array;
        scope: number;
        logId: Uint8Array;
        provenance: ProvenanceV1;
        count: number;
        anchor: Uint8Array;
        hlc: bigint;
        above: number;
        cellsFrom?: number;
        cells?: Uint8Array;
    }) {
        super();
        if (properties) {
            this.version = properties.version ?? READINESS_WIRE_VERSION;
            this.sessionId = properties.sessionId;
            this.scope = properties.scope;
            this.logId = properties.logId;
            this.provenance = properties.provenance;
            this.count = properties.count;
            this.anchor = properties.anchor;
            this.hlc = properties.hlc;
            this.above = properties.above;
            this.cellsFrom = properties.cellsFrom ?? 0;
            this.cells = properties.cells ?? new Uint8Array(0);
        }
    }
}

@variant(2)
export class CellsReqV1 extends ReadinessMessage {
    @field({ type: "u8" })
    version: number;

    @field({ type: fixedArray("u8", SESSION_ID_BYTES) })
    sessionId: Uint8Array;

    @field({ type: "u8" })
    scope: number;

    @field({ type: fixedArray("u8", LOG_ID_BYTES) })
    logId: Uint8Array;

    @field({ type: "u32" })
    from: number;

    @field({ type: "u32" })
    to: number;

    constructor(properties?: {
        version?: number;
        sessionId: Uint8Array;
        scope: number;
        logId: Uint8Array;
        from: number;
        to: number;
    }) {
        super();
        if (properties) {
            this.version = properties.version ?? READINESS_WIRE_VERSION;
            this.sessionId = properties.sessionId;
            this.scope = properties.scope;
            this.logId = properties.logId;
            this.from = properties.from;
            this.to = properties.to;
        }
    }
}

@variant(3)
export class CellsV1 extends ReadinessMessage {
    @field({ type: "u8" })
    version: number;

    @field({ type: fixedArray("u8", SESSION_ID_BYTES) })
    sessionId: Uint8Array;

    @field({ type: "u8" })
    scope: number;

    @field({ type: fixedArray("u8", LOG_ID_BYTES) })
    logId: Uint8Array;

    @field({ type: "u32" })
    from: number;

    @field({ type: Uint8Array })
    cells: Uint8Array;

    constructor(properties?: {
        version?: number;
        sessionId: Uint8Array;
        scope: number;
        logId: Uint8Array;
        from: number;
        cells: Uint8Array;
    }) {
        super();
        if (properties) {
            this.version = properties.version ?? READINESS_WIRE_VERSION;
            this.sessionId = properties.sessionId;
            this.scope = properties.scope;
            this.logId = properties.logId;
            this.from = properties.from;
            this.cells = properties.cells;
        }
    }
}

@variant(4)
export class ListPageV1 extends ReadinessMessage {
    @field({ type: "u8" })
    version: number;

    @field({ type: fixedArray("u8", SESSION_ID_BYTES) })
    sessionId: Uint8Array;

    @field({ type: "u8" })
    scope: number;

    @field({ type: fixedArray("u8", LOG_ID_BYTES) })
    logId: Uint8Array;

    @field({ type: "u32" })
    offset: number;

    constructor(properties?: {
        version?: number;
        sessionId: Uint8Array;
        scope: number;
        logId: Uint8Array;
        offset: number;
    }) {
        super();
        if (properties) {
            this.version = properties.version ?? READINESS_WIRE_VERSION;
            this.sessionId = properties.sessionId;
            this.scope = properties.scope;
            this.logId = properties.logId;
            this.offset = properties.offset;
        }
    }
}

@variant(5)
export class ListV1 extends ReadinessMessage {
    @field({ type: "u8" })
    version: number;

    @field({ type: fixedArray("u8", SESSION_ID_BYTES) })
    sessionId: Uint8Array;

    @field({ type: "u8" })
    scope: number;

    @field({ type: fixedArray("u8", LOG_ID_BYTES) })
    logId: Uint8Array;

    @field({ type: "u32" })
    offset: number;

    /** n x 32-byte elements, n <= LIST_PAGE_HASHES. */
    @field({ type: Uint8Array })
    hashes: Uint8Array;

    @field({ type: "bool" })
    done: boolean;

    constructor(properties?: {
        version?: number;
        sessionId: Uint8Array;
        scope: number;
        logId: Uint8Array;
        offset: number;
        hashes: Uint8Array;
        done: boolean;
    }) {
        super();
        if (properties) {
            this.version = properties.version ?? READINESS_WIRE_VERSION;
            this.sessionId = properties.sessionId;
            this.scope = properties.scope;
            this.logId = properties.logId;
            this.offset = properties.offset;
            this.hashes = properties.hashes;
            this.done = properties.done;
        }
    }
}

@variant(6)
export class CloseV1 extends ReadinessMessage {
    @field({ type: "u8" })
    version: number;

    @field({ type: fixedArray("u8", SESSION_ID_BYTES) })
    sessionId: Uint8Array;

    constructor(properties?: { version?: number; sessionId: Uint8Array }) {
        super();
        if (properties) {
            this.version = properties.version ?? READINESS_WIRE_VERSION;
            this.sessionId = properties.sessionId;
        }
    }
}

@variant(7)
export class ErrorV1 extends ReadinessMessage {
    @field({ type: "u8" })
    version: number;

    @field({ type: fixedArray("u8", SESSION_ID_BYTES) })
    sessionId: Uint8Array;

    @field({ type: "u8" })
    code: number;

    constructor(properties?: {
        version?: number;
        sessionId: Uint8Array;
        code: ErrorCode;
    }) {
        super();
        if (properties) {
            this.version = properties.version ?? READINESS_WIRE_VERSION;
            this.sessionId = properties.sessionId;
            this.code = properties.code;
        }
    }
}

@variant(8)
export class StateNoticeV1 extends ReadinessMessage {
    @field({ type: "u8" })
    version: number;

    @field({ type: ProvenanceV1 })
    provenance: ProvenanceV1;

    @field({ type: "u8" })
    reason: number;

    constructor(properties?: {
        version?: number;
        provenance: ProvenanceV1;
        reason: number;
    }) {
        super();
        if (properties) {
            this.version = properties.version ?? READINESS_WIRE_VERSION;
            this.provenance = properties.provenance;
            this.reason = properties.reason;
        }
    }
}

export const encodeReadinessMessage = (message: ReadinessMessage) =>
    serialize(message);

/** Throws a BorshError for an unknown variant or a malformed layout. */
export const decodeReadinessMessage = (bytes: Uint8Array) =>
    deserialize(bytes, ReadinessMessage);

/** Messages that name a scope and that scope's log. */
export type ScopedMessage =
    | HeaderV1
    | CellsReqV1
    | CellsV1
    | ListPageV1
    | ListV1;

export const isScopedMessage = (
    message: ReadinessMessage
): message is ScopedMessage =>
    message instanceof HeaderV1 ||
    message instanceof CellsReqV1 ||
    message instanceof CellsV1 ||
    message instanceof ListPageV1 ||
    message instanceof ListV1;

const validProvenance = (provenance: ProvenanceV1) =>
    provenance.formatTag === READINESS_FORMAT_TAG &&
    provenance.source < PROVENANCE_SOURCES.length &&
    provenance.phase < PROVENANCE_PHASES.length;

/**
 * The decode guard: checks what Borsh cannot (version, scope ids, sizes and
 * ranges). Returns `undefined` for a well-formed message, an `ErrorV1` code
 * the receiver answers with, or `"drop"` for a message that gets no answer
 * (a malformed answer, or a message without a session to answer).
 * Log ids are checked by the receiver, which knows its scopes' logs.
 */
export const checkReadinessMessage = (
    message: ReadinessMessage
): ErrorCode | "drop" | undefined => {
    const versioned = message as { version?: number; sessionId?: unknown };
    if (versioned.version !== READINESS_WIRE_VERSION) {
        return versioned.sessionId instanceof Uint8Array &&
            !(message instanceof ErrorV1)
            ? ERROR_CODE.UNSUPPORTED
            : "drop";
    }
    if (message instanceof OpenV1) {
        if ((message.flags & ~OPEN_FLAGS_KNOWN) !== 0) {
            return ERROR_CODE.UNSUPPORTED;
        }
        if (
            message.scopes.length === 0 ||
            message.scopes.length > MAX_OPEN_SCOPES
        ) {
            return ERROR_CODE.SCOPE;
        }
        const seen = new Set<number>();
        for (const scope of message.scopes) {
            if (!isScopeId(scope.scope) || seen.has(scope.scope)) {
                return ERROR_CODE.SCOPE;
            }
            seen.add(scope.scope);
        }
        return undefined;
    }
    if (isScopedMessage(message) && !isScopeId(message.scope)) {
        return message instanceof CellsReqV1 || message instanceof ListPageV1
            ? ERROR_CODE.SCOPE
            : "drop";
    }
    if (message instanceof HeaderV1) {
        const n = message.cells.length / CELL_BYTES;
        return validProvenance(message.provenance) &&
            Number.isInteger(n) &&
            n <= PUSH_MAX &&
            message.cellsFrom + n <= M
            ? undefined
            : "drop";
    }
    if (message instanceof CellsReqV1) {
        return message.from < message.to && message.to <= M
            ? undefined
            : ERROR_CODE.SCOPE;
    }
    if (message instanceof CellsV1) {
        const n = message.cells.length / CELL_BYTES;
        return Number.isInteger(n) && message.from + n <= M
            ? undefined
            : "drop";
    }
    if (message instanceof ListV1) {
        const n = message.hashes.length / DIGEST_BYTES;
        return Number.isInteger(n) && n <= LIST_PAGE_HASHES
            ? undefined
            : "drop";
    }
    if (message instanceof ErrorV1) {
        return message.code <= ERROR_CODE.SCOPE ? undefined : "drop";
    }
    if (message instanceof StateNoticeV1) {
        return validProvenance(message.provenance) &&
            message.reason <= NOTICE_REASON.WARM_FRESH
            ? undefined
            : "drop";
    }
    return undefined;
};
