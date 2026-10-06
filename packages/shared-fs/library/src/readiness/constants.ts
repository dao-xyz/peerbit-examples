/**
 * Sizes, caps and timeouts of proof-based write readiness
 * (WRITE_READINESS_V2.md section 4). The wire layouts that depend on them
 * are frozen once a v9.2 build is released (see wire.ts).
 */

/** Format tag every `ProvenanceV1` carries; matches the store salt. */
export const READINESS_FORMAT_TAG = "shared-fs/v9.2";
/** Salt suffix of the readiness RPC topic. */
export const READINESS_TOPIC_SALT = "/shared-fs/v9.2/readiness";

/** Maintained rateless IBLT prefix: cells per scope. */
export const M = 4096;
/** u32 lanes of one element in a cell (a full 32-byte entry hash). */
export const L = 8;
/** One cell on the wire: 32 B XOR of hashes, 8 B XOR of checksums, 4 B count. */
export const CELL_BYTES = 4 * L + 8 + 4;
/** LtHash32 anchor lanes (4 KiB). */
export const LANES = 1024;
/** Bytes of one element: the multihash digest of an entry hash. */
export const DIGEST_BYTES = 32;

/** Cells a responder pushes with its header when 0 < gapEst <= T_SYNC. */
export const PUSH_MAX = 480;
/** Gap at or below which cells are pushed or requested at once. */
export const T_SYNC = 256;
/** Above this gap the joiner asks for no cells and waits for sync. */
export const FETCH_MAX = 2800;
/** Hashes per `ListV1` page (64 KiB). */
export const LIST_PAGE_HASHES = 2048;
/** Scopes one `OpenV1` may carry (namespace and trust). */
export const MAX_OPEN_SCOPES = 2;
/** Largest answer a joiner accepts; more marks the peer inconsistent. */
export const MAX_ANSWER_BYTES = 256 * 1024;

/**
 * Responder sessions per requesting peer, by signing key. Keys cost nothing
 * to create and every request restarts a session's idle timer, so a few
 * throwaway identities that keep re-sending can hold all 16 sessions, and
 * every honest joiner then gets `BUSY` (beyond 256 waiters, without a
 * notice). That denies readiness up to the caller's timeout (design 5,
 * "Stalling"); it never makes a joiner ready. Known limit: no session
 * lifetime and no capacity reserved for trusted keys yet (PR-3 decides).
 */
export const SESSIONS_PER_PEER = 4;
/** Responder sessions in total. */
export const SESSIONS_TOTAL = 16;
/** Peers a responder remembers for a `StateNoticeV1`. */
export const NOTICE_TARGETS = 256;
/** A responder session expires after this long without a request. */
export const SESSION_IDLE_MS = 30_000;
/** OPEN attempts: the first waits this long, then x2 and x4. */
export const REQUEST_TIMEOUT_MS = 5_000;
/** `SharedLog.join` timeout of one pull batch. */
export const PULL_TIMEOUT_MS = 10_000;
/** Hashes per pull batch. */
export const PULL_BATCH = 256;
