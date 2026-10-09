import { Or, StringMatch, type Query } from "@peerbit/document";
import { IdentityRelation } from "@peerbit/trusted-network";
import { ChangesetManifest, FileVersion, NamingEvent } from "../model.js";
import type { IdKey } from "./id-map.js";

/**
 * The row sets readiness reconciles (WRITE_READINESS_V2.md section 4.2).
 * Every per-scope operation uses that scope's own Documents: its change
 * events, its index and its log.
 */

export const SCOPE_NAMESPACE_V1 = 0;
export const SCOPE_TRUST_V1 = 1;
export type ScopeId = typeof SCOPE_NAMESPACE_V1 | typeof SCOPE_TRUST_V1;

export const isScopeId = (value: number): value is ScopeId =>
    value === SCOPE_NAMESPACE_V1 || value === SCOPE_TRUST_V1;

/** Index row kinds of the namespace scope. */
export const NAMESPACE_KINDS = [
    "naming",
    "file-version",
    "changeset-manifest",
] as const;
const NAMESPACE_KIND_SET: ReadonlySet<string> = new Set(NAMESPACE_KINDS);

/** 16-byte anchor domain tag (the AES-256-CTR IV) of a scope. */
const tag = (text: string) => {
    const out = new Uint8Array(16);
    out.set(new TextEncoder().encode(text));
    return out;
};

export interface ScopeDescriptor {
    readonly id: ScopeId;
    /** Name in file names and proof records. */
    readonly name: "namespace-v1" | "trust-v1";
    readonly ivTag: Uint8Array;
    /**
     * Whether a change-event value belongs to the scope. By class, never by
     * `value.kind`: `kind` is a plain initializer, absent on removed values,
     * remote arrivals and Guard D re-puts (M0 P4).
     */
    classify(value: unknown): boolean;
    /** The map key of a change-event value or an index row. */
    key(value: any): IdKey | undefined;
    /** Whether an index row read back by id belongs to the scope. */
    indexedRowInScope(row: any): boolean;
    /** Query of a seed scan or a projected count. */
    scanQuery(): Query[];
    /** Projection of a seed scan (key fields plus head and modified). */
    readonly scanShape: Record<string, any>;
}

const CONTEXT_SHAPE = { head: true, modified: true };

export const NAMESPACE_V1: ScopeDescriptor = {
    id: SCOPE_NAMESPACE_V1,
    name: "namespace-v1",
    ivTag: tag("sfs/ns-v1"),
    classify: (value) =>
        value instanceof NamingEvent ||
        value instanceof FileVersion ||
        value instanceof ChangesetManifest,
    key: (value) => (typeof value?.id === "string" ? value.id : undefined),
    indexedRowInScope: (row) => NAMESPACE_KIND_SET.has(row?.kind),
    scanQuery: () => [
        new Or(
            NAMESPACE_KINDS.map(
                (kind) => new StringMatch({ key: "kind", value: kind })
            )
        ),
    ],
    scanShape: { id: true, kind: true, __context: CONTEXT_SHAPE },
};

export const TRUST_V1: ScopeDescriptor = {
    id: SCOPE_TRUST_V1,
    name: "trust-v1",
    ivTag: tag("sfs/trust-v1"),
    classify: (value) => value instanceof IdentityRelation,
    key: (value) => (value?.id instanceof Uint8Array ? value.id : undefined),
    indexedRowInScope: () => true,
    scanQuery: () => [],
    scanShape: { id: true, __context: CONTEXT_SHAPE },
};

export const scopeDescriptor = (scope: ScopeId): ScopeDescriptor =>
    scope === SCOPE_NAMESPACE_V1 ? NAMESPACE_V1 : TRUST_V1;
