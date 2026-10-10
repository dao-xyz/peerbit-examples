import {
    NAMESPACE_V1,
    TRUST_V1,
    scopeDescriptor,
    type ScopeDescriptor,
    type ScopeId,
} from "./scopes.js";
import { PROVENANCE_SOURCES, type ProvenanceSource } from "./wire.js";

/**
 * The readiness proof a joiner persists in its sidecar when it turns ready
 * (WRITE_READINESS_V2.md section 4.10, M1 plan section 6.1). It is for
 * audit, status and telemetry: nothing re-reads it to decide readiness. The
 * next open reads `hlcProved`, which only shapes the gap estimate (section
 * 4.5 step 4), from its own sidecar key, so the fresh-open gate reset that
 * clears the proof does not clear it (deviation g).
 *
 * The sidecar parser checks the proof for shape only; a bad shape is
 * malformed and fails closed through the existing path. A bad `hlcProved` is
 * read as 0: it is a hint, and failing closed would be out of proportion.
 */

export const PROOF_VERSION = 1;
/** Records kept per array: contained, excluded and gaps (design 4.10). */
export const PROOF_MAX_RECORDS = 32;

export type ProofScope = ScopeDescriptor["name"];

/** Why a peer stopped counting: a provable lie (design 4.7). */
export type ExclusionReason = "inconsistent" | "unsubstantiated";

/**
 * One contained scope of one peer. The design's record has no scope; with
 * both scopes in access-controlled stores a peer has two records, so
 * `scope` is added (32 records hold 16 such peers).
 */
export interface ProofContained {
    /** The peer's `hashcode()`. */
    peer: string;
    scope: ProofScope;
    source: ProvenanceSource;
    /**
     * Qualified in the header of the session that contained it and, in
     * access-controlled stores, with an identity J trusts (design 2.1).
     */
    qualified: boolean;
    count: number;
    /** The snapshot's `hlc`, a decimal u64. */
    hlc: string;
    /** D_R, 64 lowercase hex characters. */
    anchor: string;
    /**
     * Access-controlled stores only: the peer's identity in J's trust graph
     * at the decision (design 2.1), absent while a check was still running.
     */
    identity?: "trusted" | "untrusted";
    /**
     * Access-controlled stores only: the provisional `rejected-untrusted`
     * heads this result explained (design 2.3: the stale-grant and
     * revocation exposure the proof states), only when above 0.
     */
    untrusted?: number;
}

export interface ProofExcluded {
    peer: string;
    reason: ExclusionReason;
}

/** A peer that left while J still lacked rows only it listed (D4). */
export interface ProofGap {
    peer: string;
    missing: number | "unknown";
}

export interface Proof {
    v: typeof PROOF_VERSION;
    scopes: ProofScope[];
    contained: ProofContained[];
    excluded: ProofExcluded[];
    gaps: ProofGap[];
}

/**
 * A contained session result, as the proof needs it. `identity` and
 * `untrusted` are the coordinator's, in access-controlled stores only.
 */
export interface ContainedInput {
    peer: string;
    scope: ScopeId;
    source: ProvenanceSource;
    qualified: boolean;
    count: number;
    hlc: bigint;
    anchor: Uint8Array;
    identity?: "trusted" | "untrusted";
    untrusted?: number;
}

export type ProofValidation =
    | { ok: true; proof: Proof }
    | { ok: false; reason: string };

const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffff_ffff;
const PEER_MAX_CHARS = 128;
const HLC_PATTERN = /^[0-9]{1,20}$/;
const ANCHOR_PATTERN = /^[0-9a-f]{64}$/;
/** Namespace first: the order `scopes` and the record sort use. */
const SCOPE_NAMES: readonly ProofScope[] = [NAMESPACE_V1.name, TRUST_V1.name];
const EXCLUSION_REASONS: readonly ExclusionReason[] = [
    "inconsistent",
    "unsubstantiated",
];

const hexOf = (bytes: Uint8Array) => {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
};

/** Code-unit order: the same on every platform, unlike `localeCompare`. */
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const scopeRank = (scope: ProofScope) => SCOPE_NAMES.indexOf(scope);

/** `hlc` as the proof and the sidecar store it (decimal). */
export const formatHlc = (hlc: bigint): string => hlc.toString(10);

/**
 * The sidecar's `hlcProved` key: a decimal u64 string. Anything else,
 * missing, negative or above 2^64 - 1, reads as 0.
 */
export const parseHlcProved = (value: unknown): bigint => {
    if (typeof value !== "string" || !HLC_PATTERN.test(value)) return 0n;
    const parsed = BigInt(value);
    return parsed <= U64_MAX ? parsed : 0n;
};

/**
 * The proof of a decision, bounded and in a deterministic order: contained
 * records qualified first, then the namespace scope, then the higher `hlc`,
 * then by peer; excluded and gap records by peer; each array cut to
 * `PROOF_MAX_RECORDS`. A qualified record is kept whenever one exists.
 */
export const buildProof = (input: {
    scopes: readonly ScopeId[];
    contained: readonly ContainedInput[];
    excluded: readonly ProofExcluded[];
    gaps: readonly ProofGap[];
}): Proof => {
    const scopes = [
        ...new Set(input.scopes.map((id) => scopeDescriptor(id).name)),
    ].sort((a, b) => scopeRank(a) - scopeRank(b));
    const contained = input.contained
        .map((record) => ({
            hlc: record.hlc,
            out: {
                peer: record.peer,
                scope: scopeDescriptor(record.scope).name,
                source: record.source,
                qualified: record.qualified,
                count: record.count,
                hlc: formatHlc(record.hlc),
                anchor: hexOf(record.anchor),
                ...(record.identity === "trusted" ||
                record.identity === "untrusted"
                    ? { identity: record.identity }
                    : {}),
                ...(isU32(record.untrusted) && record.untrusted > 0
                    ? { untrusted: record.untrusted }
                    : {}),
            } satisfies ProofContained,
        }))
        // Qualified first, so the cut keeps one whenever one exists (the
        // predicate needs it, design 4.8).
        .sort(
            (a, b) =>
                Number(b.out.qualified) - Number(a.out.qualified) ||
                scopeRank(a.out.scope) - scopeRank(b.out.scope) ||
                (a.hlc > b.hlc ? -1 : a.hlc < b.hlc ? 1 : 0) ||
                compareStrings(a.out.peer, b.out.peer) ||
                compareStrings(a.out.anchor, b.out.anchor)
        )
        .slice(0, PROOF_MAX_RECORDS)
        .map(({ out }) => out);
    const excluded = input.excluded
        .map(({ peer, reason }) => ({ peer, reason }))
        .sort(
            (a, b) =>
                compareStrings(a.peer, b.peer) ||
                compareStrings(a.reason, b.reason)
        )
        .slice(0, PROOF_MAX_RECORDS);
    const gaps = input.gaps
        .map(({ peer, missing }) => ({ peer, missing }))
        .sort(
            (a, b) =>
                compareStrings(a.peer, b.peer) ||
                compareStrings(String(a.missing), String(b.missing))
        )
        .slice(0, PROOF_MAX_RECORDS);
    return { v: PROOF_VERSION, scopes, contained, excluded, gaps };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isPeer = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= PEER_MAX_CHARS;

const isU32 = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= U32_MAX;

const isHlc = (value: unknown): value is string =>
    typeof value === "string" &&
    HLC_PATTERN.test(value) &&
    BigInt(value) <= U64_MAX;

/** An array of at most `PROOF_MAX_RECORDS` records, or why not. */
const recordsOf = (
    value: unknown,
    name: string
): { records: Record<string, unknown>[] } | { reason: string } => {
    if (!Array.isArray(value)) return { reason: `${name} is not an array` };
    if (value.length > PROOF_MAX_RECORDS) {
        return { reason: `${name} holds more than ${PROOF_MAX_RECORDS}` };
    }
    const records: Record<string, unknown>[] = [];
    for (const record of value) {
        if (!isRecord(record)) {
            return { reason: `${name} holds a non-object` };
        }
        records.push(record);
    }
    return { records };
};

const validate = (value: unknown): ProofValidation => {
    if (!isRecord(value)) return { ok: false, reason: "not an object" };
    if (value.v !== PROOF_VERSION) return { ok: false, reason: "version" };
    const scopesValue = value.scopes;
    if (
        !Array.isArray(scopesValue) ||
        scopesValue.length < 1 ||
        scopesValue.length > SCOPE_NAMES.length ||
        !scopesValue.every((scope) => SCOPE_NAMES.includes(scope)) ||
        new Set(scopesValue).size !== scopesValue.length
    ) {
        return { ok: false, reason: "scopes" };
    }
    const scopes = [...scopesValue] as ProofScope[];
    const containedIn = recordsOf(value.contained, "contained");
    if ("reason" in containedIn) return { ok: false, ...containedIn };
    const excludedIn = recordsOf(value.excluded, "excluded");
    if ("reason" in excludedIn) return { ok: false, ...excludedIn };
    const gapsIn = recordsOf(value.gaps, "gaps");
    if ("reason" in gapsIn) return { ok: false, ...gapsIn };

    const contained: ProofContained[] = [];
    for (const record of containedIn.records) {
        const { peer, scope, source, qualified, count, hlc, anchor } = record;
        const { identity, untrusted } = record;
        if (
            !isPeer(peer) ||
            !scopes.includes(scope as ProofScope) ||
            !(PROVENANCE_SOURCES as readonly unknown[]).includes(source) ||
            typeof qualified !== "boolean" ||
            !isU32(count) ||
            !isHlc(hlc) ||
            typeof anchor !== "string" ||
            !ANCHOR_PATTERN.test(anchor) ||
            (identity !== undefined &&
                identity !== "trusted" &&
                identity !== "untrusted") ||
            (untrusted !== undefined && !isU32(untrusted))
        ) {
            return { ok: false, reason: "contained record" };
        }
        contained.push({
            peer,
            scope: scope as ProofScope,
            source: source as ProvenanceSource,
            qualified,
            count,
            hlc,
            anchor,
            ...(identity !== undefined ? { identity } : {}),
            ...(untrusted !== undefined ? { untrusted } : {}),
        });
    }
    const excluded: ProofExcluded[] = [];
    for (const { peer, reason } of excludedIn.records) {
        if (
            !isPeer(peer) ||
            !EXCLUSION_REASONS.includes(reason as ExclusionReason)
        ) {
            return { ok: false, reason: "excluded record" };
        }
        excluded.push({ peer, reason: reason as ExclusionReason });
    }
    const gaps: ProofGap[] = [];
    for (const { peer, missing } of gapsIn.records) {
        if (!isPeer(peer) || !(isU32(missing) || missing === "unknown")) {
            return { ok: false, reason: "gap record" };
        }
        gaps.push({ peer, missing });
    }
    return {
        ok: true,
        proof: { v: PROOF_VERSION, scopes, contained, excluded, gaps },
    };
};

/**
 * The sidecar parser's shape check. Never throws. Accepts `v: 1`, one or
 * two distinct known scopes, at most `PROOF_MAX_RECORDS` records per array,
 * and records whose fields have the right types and bounds (peer 1-128
 * characters, a scope listed in `scopes`, a known source and reason, `count`
 * and `missing` u32, `hlc` a decimal u64, `anchor` 64 lowercase hex, and when
 * present `identity` `trusted` or `untrusted` and `untrusted` a u32). Keys it
 * does not know are ignored and not copied.
 */
export const validateProof = (value: unknown): ProofValidation => {
    try {
        return validate(value);
    } catch (error: any) {
        // A hostile value (a throwing getter or proxy) is malformed too.
        return {
            ok: false,
            reason: `unreadable: ${error?.message ?? String(error)}`,
        };
    }
};

/** The highest `hlc` of a contained namespace record; 0 without one. */
export const hlcProvedOf = (proof: Proof): bigint => {
    let out = 0n;
    for (const record of proof.contained) {
        if (record.scope !== NAMESPACE_V1.name) continue;
        const hlc = parseHlcProved(record.hlc);
        if (hlc > out) out = hlc;
    }
    return out;
};
