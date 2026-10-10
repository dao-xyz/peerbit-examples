import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedFileSystem } from "../index.js";
import {
    buildProof,
    hlcProvedOf,
    validateProof,
    type Proof,
} from "../readiness/proof.js";
import { SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1 } from "../readiness/scopes.js";

/**
 * The sidecar's readiness keys after PR-3 commit 4 (SPEC4 section 4, M1 plan
 * 6.1, design 4.10), on the real reader and writer of a `SharedFileSystem`
 * whose node is only a temporary directory (no Peerbit):
 *
 * - S6: every write that does not name `proof` or `hlcProved` carries them,
 *   so a crash marker or a bootstrap transition never drops what the last
 *   decision persisted;
 * - the allowlist `creator | reconciled | operator`; the retired
 *   `remote-settled` and unknown sources read as malformed, which fails
 *   closed as an interrupted bootstrap;
 * - a proof checked for shape only, a malformed one failing closed, and
 *   `hlcProved` a hint that reads as 0 when malformed and never fails the
 *   file;
 * - the writer's invariant: a proof only beside `writeReady: true` from a
 *   `reconciled` decision.
 *
 * Each patch below is the literal its call site passes in `src/index.ts`;
 * the reconciled decision and `assumeComplete()`'s operator write run the
 * real `commitWriteReady`, and the drop gate the real `drop()` (the store's
 * own deletion stubbed).
 */

/** A proof whose highest namespace `hlc` is `hlc`. */
const proofAt = (hlc: bigint, peer = "donor"): Proof =>
    buildProof({
        scopes: [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1],
        contained: [
            {
                peer,
                scope: SCOPE_NAMESPACE_V1,
                source: "creator",
                qualified: true,
                count: 12,
                hlc,
                anchor: new Uint8Array(32).fill(7),
                identity: "trusted",
                untrusted: 2,
            },
            {
                peer,
                scope: SCOPE_TRUST_V1,
                source: "creator",
                qualified: true,
                count: 1,
                hlc: hlc + 1_000n,
                anchor: new Uint8Array(32).fill(9),
                identity: "trusted",
            },
        ],
        excluded: [],
        gaps: [],
    });

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

/** The fail-closed read of a malformed or unreadable file. */
const FAIL_CLOSED = {
    bootstrap: "active",
    writeReady: false,
    hlcProved: 0n,
};

describe("readiness sidecar (PR-3 commit 4)", () => {
    const roots: string[] = [];

    afterEach(async () => {
        for (const root of roots.splice(0)) {
            await rm(root, { recursive: true, force: true });
        }
    });

    /**
     * A filesystem program whose node is a temporary directory: enough for
     * the sidecar's path, reader, writer and the flip's commit, whose other
     * effects are stubs.
     */
    const fixture = async () => {
        const root = await mkdtemp(join(tmpdir(), "shared-fs-sidecar-"));
        roots.push(root);
        const program: any = new SharedFileSystem();
        Object.assign(program, {
            node: { directory: root },
            address: "sidecar-fixture",
            openGeneration: 7,
            writeReadinessRequired: true,
            writesReady: false,
            writeReadinessWaiters: [],
        });
        program.setGuardArmed = vi.fn();
        program.emitWriteReadyOnce = vi.fn();
        program.bootstrapStatus = vi.fn(() => ({
            writeReady: program.writesReady,
        }));
        program.readinessRuntime = { markReady: vi.fn() };
        const path = join(root, "shared-fs-bootstrap", "sidecar-fixture.json");
        return {
            program,
            path,
            /** The file as written. */
            raw: async () => JSON.parse(await readFile(path, "utf8")),
            /** Replaces the file with `value` (a file another build wrote). */
            put: async (value: unknown) => {
                await mkdir(join(root, "shared-fs-bootstrap"), {
                    recursive: true,
                });
                await writeFile(
                    path,
                    typeof value === "string" ? value : JSON.stringify(value)
                );
            },
            read: () => program.readBootstrapState(),
            patch: (patch: Record<string, unknown>) =>
                program.writeBootstrapState(patch, 7, true),
            /** The reconciled decision's commit, then the open's state back. */
            reconcile: async (proof: Proof) => {
                await program.commitWriteReady(7, "reconciled", proof);
                program.writesReady = false;
                program.writeReadinessRequired = true;
            },
        };
    };

    /** Every key of the file says what the decision persisted. */
    const expectReconciled = (raw: any, proof: Proof) =>
        expect(raw).toEqual({
            writeReady: true,
            writeReadySource: "reconciled",
            proof: json(proof),
            hlcProved: hlcProvedOf(proof).toString(),
        });

    it("the reconciled decision persists its proof and hlcProved, which read back as written", async () => {
        const { raw, read, reconcile, program } = await fixture();
        const proof = proofAt(12_345n);
        await reconcile(proof);
        expectReconciled(await raw(), proof);
        expect(hlcProvedOf(proof)).toBe(12_345n);
        expect(validateProof((await raw()).proof)).toEqual({
            ok: true,
            proof,
        });
        expect(await read()).toEqual({
            writeReady: true,
            writeReadySource: "reconciled",
            bootstrap: undefined,
            proof,
            hlcProved: 12_345n,
        });
        // The flip followed the durable write.
        expect(program.writeReadinessSource).toBe("reconciled");
        expect(program.readinessRuntime.markReady).toHaveBeenCalledTimes(1);
    });

    describe("S6: what each write carries", () => {
        /**
         * Each call site's patch (SPEC4 4.3), applied over a reconciled
         * file: whether the proof and `hlcProved` survive it.
         */
        const PATCHES: Array<{
            name: string;
            apply: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>;
            proof: boolean;
            hlcProved: boolean;
        }> = [
            {
                name: "the pre-open crash marker",
                apply: (f) => f.patch({ bootstrap: "active" }),
                proof: true,
                hlcProved: true,
            },
            {
                name: "a bootstrap's fetch (active)",
                apply: (f) => f.patch({ bootstrap: "active" }),
                proof: true,
                hlcProved: true,
            },
            {
                name: "the unverified posture",
                apply: (f) => f.patch({ bootstrap: "unverified" }),
                proof: true,
                hlcProved: true,
            },
            {
                name: "an abandoned bootstrap, a verified retirement or quiescence (null)",
                apply: (f) => f.patch({ bootstrap: null }),
                proof: true,
                hlcProved: true,
            },
            {
                // Under the invariant: the creator's source is not a
                // reconciled decision (SPEC4 9.4(5)'s last bullet).
                name: "a creating open",
                apply: (f) =>
                    f.patch({ writeReady: true, writeReadySource: "creator" }),
                proof: false,
                hlcProved: true,
            },
            {
                name: "a creating observer",
                apply: (f) =>
                    f.patch({ writeReady: false, writeReadySource: null }),
                proof: false,
                hlcProved: true,
            },
            {
                name: "assumeComplete() (operator)",
                apply: (f) => f.program.commitWriteReady(7, "operator"),
                proof: false,
                hlcProved: true,
            },
            {
                name: "the fresh address-open's gate reset",
                apply: (f) =>
                    f.patch({
                        writeReady: false,
                        writeReadySource: null,
                        proof: null,
                    }),
                proof: false,
                hlcProved: true,
            },
        ];

        it.each(PATCHES)("$name", async (spec) => {
            const f = await fixture();
            const proof = proofAt(777n);
            await f.reconcile(proof);
            await spec.apply(f);
            const raw = await f.raw();
            const state = await f.read();
            if (spec.proof) {
                expect(raw.proof).toEqual(json(proof));
                expect(state.proof).toEqual(proof);
            } else {
                expect(raw).not.toHaveProperty("proof");
                expect(state.proof).toBeUndefined();
            }
            if (spec.hlcProved) {
                expect(raw.hlcProved).toBe("777");
                expect(state.hlcProved).toBe(777n);
            } else {
                expect(raw).not.toHaveProperty("hlcProved");
                expect(state.hlcProved).toBe(0n);
            }
            // The invariant holds after every write.
            if ("proof" in raw) {
                expect(raw).toMatchObject({
                    writeReady: true,
                    writeReadySource: "reconciled",
                });
            }
        });

        it("every transition in a row keeps both, and a later decision replaces them", async () => {
            const f = await fixture();
            const first = proofAt(500n);
            await f.reconcile(first);
            for (const patch of [
                { bootstrap: "active" },
                { bootstrap: "unverified" },
                { bootstrap: null },
                { bootstrap: "active" },
                { bootstrap: null },
            ]) {
                await f.patch(patch);
                expect(await f.raw()).toMatchObject({
                    proof: json(first),
                    hlcProved: "500",
                });
            }
            const second = proofAt(900n, "other-donor");
            await f.reconcile(second);
            expectReconciled(await f.raw(), second);
            // A decision over an empty namespace (a genesis-only donor,
            // `hlc` 0) proves nothing above 0: its hint 0 is written as no
            // key, replacing the last one (SPEC4 4.3).
            const empty = buildProof({
                scopes: [SCOPE_NAMESPACE_V1],
                contained: [
                    {
                        peer: "genesis",
                        scope: SCOPE_NAMESPACE_V1,
                        source: "creator",
                        qualified: true,
                        count: 0,
                        hlc: 0n,
                        anchor: new Uint8Array(32),
                    },
                ],
                excluded: [],
                gaps: [],
            });
            expect(hlcProvedOf(empty)).toBe(0n);
            await f.reconcile(empty);
            expect(await f.raw()).toEqual({
                writeReady: true,
                writeReadySource: "reconciled",
                proof: json(empty),
            });
        });

        /**
         * The fixture made droppable: open, a runtime that blocks and
         * settles, and Program.drop (the store's deletion) stubbed to record
         * the file as it stood when the store went.
         */
        const droppable = (f: Awaited<ReturnType<typeof fixture>>) => {
            const runtime = {
                markReady: f.program.readinessRuntime.markReady,
                block: vi.fn(),
                whenPullsSettled: vi.fn(async () => {}),
                disposeWithoutPersist: vi.fn(),
            };
            Object.assign(f.program, {
                closed: false,
                readinessRuntime: runtime,
            });
            const atStoreDrop: unknown[] = [];
            const storeDrop = vi
                .spyOn(
                    Object.getPrototypeOf(SharedFileSystem.prototype),
                    "drop"
                )
                .mockImplementation(async () => {
                    atStoreDrop.push(await f.raw());
                    return true;
                });
            return { runtime, atStoreDrop, storeDrop };
        };

        it("drop() during a decision's sidecar write: no flip, and the gate deletes both, leaving exactly {writeReady: false} before the store goes (G4-8)", async () => {
            const f = await fixture();
            await f.reconcile(proofAt(321n));
            const { runtime, atStoreDrop, storeDrop } = droppable(f);
            try {
                // drop() begins while the next decision's sidecar write runs.
                const replace = f.program.replaceBootstrapState;
                const written: any[] = [];
                let began!: () => void;
                const writing = new Promise<void>(
                    (resolve) => (began = resolve)
                );
                let release!: () => void;
                const held = new Promise<void>(
                    (resolve) => (release = resolve)
                );
                f.program.replaceBootstrapState = async function (
                    this: any,
                    path: string,
                    contents: string
                ) {
                    written.push(JSON.parse(contents));
                    if (written.length === 1) {
                        began();
                        await held;
                    }
                    return replace.call(this, path, contents);
                };
                const proof = proofAt(654n);
                const deciding = f.program.serializeWriteReadinessTransition(
                    () => f.program.commitWriteReady(7, "reconciled", proof)
                );
                await writing;
                const dropping = f.program.drop();
                release();
                expect(await dropping).toBe(true);
                await deciding;
                expect(written).toEqual([
                    {
                        writeReady: true,
                        writeReadySource: "reconciled",
                        proof: json(proof),
                        hlcProved: "654",
                    },
                    { writeReady: false },
                ]);
                expect(storeDrop).toHaveBeenCalledTimes(1);
                expect(atStoreDrop).toEqual([{ writeReady: false }]);
                expect(await f.raw()).toEqual({ writeReady: false });
                expect(await f.read()).toEqual({
                    writeReady: false,
                    bootstrap: undefined,
                    writeReadySource: undefined,
                    hlcProved: 0n,
                });
                // The flip never happened.
                expect(f.program.writesReady).toBe(false);
                expect(runtime.markReady).toHaveBeenCalledTimes(1);
            } finally {
                storeDrop.mockRestore();
            }
        });

        it("drop() of a ready replica gates a creator's or a decision's sidecar before the store goes; a failed write fails the drop and keeps the store", async () => {
            for (const ready of ["creator", "reconciled"] as const) {
                const f = await fixture();
                if (ready === "reconciled") await f.reconcile(proofAt(321n));
                else
                    await f.patch({
                        writeReady: true,
                        writeReadySource: "creator",
                    });
                const { atStoreDrop, storeDrop } = droppable(f);
                try {
                    expect(await f.program.drop()).toBe(true);
                    expect(atStoreDrop).toEqual([{ writeReady: false }]);
                } finally {
                    storeDrop.mockRestore();
                }
            }

            const f = await fixture();
            await f.reconcile(proofAt(321n));
            const { storeDrop } = droppable(f);
            try {
                f.program.replaceBootstrapState = async () => {
                    throw new Error("test: the disk refused the gate");
                };
                await expect(f.program.drop()).rejects.toMatchObject({
                    code: "EIO",
                });
                expect(storeDrop).not.toHaveBeenCalled();
                expectReconciled(await f.raw(), proofAt(321n));
            } finally {
                storeDrop.mockRestore();
            }
        });
    });

    describe("the reader", () => {
        it("accepts creator, reconciled and operator", async () => {
            for (const source of ["creator", "reconciled", "operator"]) {
                const f = await fixture();
                await f.put({ writeReady: true, writeReadySource: source });
                expect(await f.read()).toEqual({
                    writeReady: true,
                    writeReadySource: source,
                    bootstrap: undefined,
                    hlcProved: 0n,
                });
            }
        });

        it("reads remote-settled and unknown sources as malformed: an interrupted bootstrap (G4-7)", async () => {
            for (const value of [
                // What PR-2 and commits 2-3 wrote.
                { writeReady: true, writeReadySource: "remote-settled" },
                {
                    writeReady: true,
                    writeReadySource: "remote-settled",
                    hlcProved: "50",
                },
                { writeReady: false, writeReadySource: "remote-settled" },
                { writeReady: true, writeReadySource: "warm" },
                { writeReady: true, writeReadySource: "peer" },
                { writeReady: true, writeReadySource: "" },
                { writeReady: true, writeReadySource: null },
                { writeReady: true },
                // A source beside a gated state.
                { writeReady: false, writeReadySource: "creator" },
            ]) {
                const f = await fixture();
                await f.put(value);
                expect(await f.read(), JSON.stringify(value)).toEqual(
                    FAIL_CLOSED
                );
            }
        });

        it("checks a proof for shape only: a valid one is returned, a malformed one fails closed, null is none", async () => {
            const proof = proofAt(42n);
            const f = await fixture();
            await f.put({
                writeReady: true,
                writeReadySource: "reconciled",
                proof: json(proof),
                hlcProved: "42",
            });
            expect(await f.read()).toEqual({
                writeReady: true,
                writeReadySource: "reconciled",
                bootstrap: undefined,
                proof,
                hlcProved: 42n,
            });

            for (const bad of [
                { ...json(proof), v: 2 },
                { ...json(proof), scopes: [] },
                { ...json(proof), contained: "all" },
                {
                    ...json(proof),
                    contained: [
                        { ...json(proof).contained[0], identity: "checking" },
                    ],
                },
                "proof",
                7,
                [],
            ]) {
                await f.put({
                    writeReady: true,
                    writeReadySource: "reconciled",
                    proof: bad,
                    hlcProved: "42",
                });
                expect(await f.read(), JSON.stringify(bad)).toEqual(
                    FAIL_CLOSED
                );
            }

            await f.put({
                writeReady: true,
                writeReadySource: "reconciled",
                proof: null,
            });
            expect(await f.read()).toEqual({
                writeReady: true,
                writeReadySource: "reconciled",
                bootstrap: undefined,
                hlcProved: 0n,
            });

            // Shape only: the reader does not cross-check a proof against
            // the source or writeReady (nothing re-reads it to decide,
            // design 4.10); the writer never leaves one there (below).
            await f.put({
                writeReady: true,
                writeReadySource: "creator",
                proof: json(proof),
            });
            expect(await f.read()).toMatchObject({
                writeReady: true,
                writeReadySource: "creator",
                proof,
            });
        });

        it("reads a malformed hlcProved as 0 without failing closed, and the next write drops it", async () => {
            for (const hlcProved of [
                "abc",
                "-1",
                "1e3",
                "0x10",
                " 1",
                "18446744073709551616",
                12,
                null,
                {},
                "0",
            ]) {
                const f = await fixture();
                await f.put({
                    writeReady: true,
                    writeReadySource: "operator",
                    hlcProved,
                });
                expect(await f.read(), JSON.stringify(hlcProved)).toEqual({
                    writeReady: true,
                    writeReadySource: "operator",
                    bootstrap: undefined,
                    hlcProved: 0n,
                });
                await f.patch({ bootstrap: "active" });
                expect(await f.raw()).toEqual({
                    writeReady: true,
                    writeReadySource: "operator",
                    bootstrap: "active",
                });
            }
        });

        it("reads a missing file as gated and an unreadable one as an interrupted bootstrap", async () => {
            const f = await fixture();
            expect(await f.read()).toEqual({
                writeReady: false,
                hlcProved: 0n,
            });
            for (const contents of ["{", "null", "[]", '"ready"', ""]) {
                await f.put(contents);
                expect(await f.read(), contents).toEqual(FAIL_CLOSED);
            }
        });
    });

    describe("the writer's invariant: a proof only beside a reconciled ready state", () => {
        it("drops the proof on every patch that leaves another state, a patch naming one included", async () => {
            const proof = proofAt(88n);
            const leaves: Array<Record<string, unknown>> = [
                { writeReady: false },
                { writeReadySource: "operator" },
                { writeReady: true, writeReadySource: "creator" },
                { writeReady: false, writeReadySource: null },
                // A patch that names the proof with a gated state.
                { writeReady: false, writeReadySource: null, proof },
                { writeReady: true, writeReadySource: "operator", proof },
            ];
            for (const patch of leaves) {
                const f = await fixture();
                await f.reconcile(proof);
                await f.patch(patch);
                const raw = await f.raw();
                expect(raw, JSON.stringify(patch)).not.toHaveProperty("proof");
                // The hint is not the proof: it stays.
                expect(raw.hlcProved).toBe("88");
            }
        });

        it("keeps no proof a file from elsewhere left beside another source", async () => {
            const proof = proofAt(99n);
            const f = await fixture();
            await f.put({
                writeReady: true,
                writeReadySource: "creator",
                proof: json(proof),
                hlcProved: "99",
            });
            await f.patch({ bootstrap: null });
            expect(await f.raw()).toEqual({
                writeReady: true,
                writeReadySource: "creator",
                hlcProved: "99",
            });
        });

        it("writes a proof only when the merged state is a reconciled ready one", async () => {
            const proof = proofAt(66n);
            const f = await fixture();
            // A gated file: a patch that names a proof alone writes none.
            await f.put({ writeReady: false });
            await f.patch({ proof });
            expect(await f.raw()).toEqual({ writeReady: false });
            // The same patch over a reconciled ready file replaces it.
            await f.reconcile(proofAt(10n));
            await f.patch({ proof });
            expect(await f.raw()).toEqual({
                writeReady: true,
                writeReadySource: "reconciled",
                proof: json(proof),
                hlcProved: "10",
            });
        });
    });
});
