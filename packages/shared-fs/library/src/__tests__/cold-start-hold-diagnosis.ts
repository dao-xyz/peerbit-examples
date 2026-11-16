import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { Peerbit } from "peerbit";
import { SharedFileSystem, type SharedFsHandle } from "../index.js";
import { NamingEvent } from "../model.js";

/**
 * Why a cold-start hold sat out its bound. The "judges an unfinished
 * bootstrap" test holds each joiner's store open until the label it just
 * wrote on the donor has committed (holdOpenUntilHistory). On Windows that
 * hold twice waited its whole 30 s ("no history arrived during open", 2 of
 * 98 runs), and a dedicated loop of 175 holds did not reproduce it. A
 * diagnosed hold records the label's way into the joiner; when the bound
 * expires it takes a snapshot, keeps the open running until the label
 * commits or HOLD_TOTAL_MS after the hold started, takes another and fails
 * with a class:
 *
 * - A, hold detection did not fire: the label was committed to the store
 *   by the bound (its change event or its index row), but the hold, which
 *   waits for that change event and then a commit diagnostic, did not
 *   release. A test bug.
 * - B, delivery liveness (upstream): by the bound no exchange message had
 *   carried the label to the joiner's shared log, and its log lacked it.
 * - C, joiner commit: the joiner had the label (received, or in its log)
 *   by the bound but had not committed it to the store.
 *
 * Until the bound only synchronous recording runs: a passing hold takes
 * no extra time.
 */
export const HOLD_TOTAL_MS = 120_000;
/** Each read of a snapshot gives up after this long. */
const READ_MS = 5_000;

/** A label a reopen writes on the donor, and its NamingEvent. */
export interface Label {
    /** The file name, `<label>.txt`. */
    name: string;
    /** The NamingEvent's entry hash, from the donor's change event. */
    hash?: string;
    /** The NamingEvent's document id. */
    id?: string;
}

/** Writes `/<label>.txt` on `donor` and returns its NamingEvent. */
export const writeLabel = async (
    donor: SharedFsHandle,
    label: string
): Promise<Label> => {
    const written: Label = { name: `${label}.txt` };
    const events = (donor.program as any).entries.events;
    const onChange = (event: any) => {
        for (const value of event?.detail?.added ?? []) {
            if (value instanceof NamingEvent && value.name === written.name) {
                written.hash = (value as any).__context?.head;
                written.id = value.id;
            }
        }
    };
    events.addEventListener("change", onChange);
    try {
        await donor.writeFile(`/${written.name}`, label);
    } finally {
        events.removeEventListener("change", onChange);
    }
    return written;
};

/** A read that gave up or failed reads "timeout" or "error". */
type Read<T> = T | "timeout" | "error" | "unknown";

export interface HoldSnapshot {
    /** Milliseconds since the store open started. */
    at: number;
    inLog: Read<boolean>;
    /** In the log's join (Log._joining). */
    joining: Read<boolean>;
    inIndex: Read<boolean>;
    /** The joiner's connections to the donor. */
    connections: Read<number>;
    /** The joiner's replicators include the donor. */
    joinerSeesDonor: Read<boolean>;
    /** The donor's replicators include the joiner. */
    donorSeesJoiner: Read<boolean>;
}

/** What a hold saw; times are milliseconds since the store open started. */
export interface HoldFacts {
    label: Label;
    /** The hold, and its bound, started. */
    holdAt: number;
    /** The bound expired. */
    boundAt: number;
    /** The diagnosis ended: the label committed, or HOLD_TOTAL_MS. */
    endAt: number;
    /** A message to the joiner's shared log named the label's hash. */
    namedAt?: number;
    namedBy?: string;
    /** An exchange message carried the label's entry to the joiner. */
    receivedAt?: number;
    receivedBy?: string;
    /** The joiner's canPerformEntry for the label. */
    canPerform?: { startAt: number; endAt?: number; result?: string };
    /** The change event that carried the label: it was committed. */
    committedAt?: number;
    /** The commit diagnostics the hold waits for. */
    commitDiagnostics: number[];
    changes: number;
    /** Change events that reset a pending match before a diagnostic. */
    clobbered: number;
    loopDelayMaxMs?: number;
    atBound: HoldSnapshot;
    atEnd: HoldSnapshot;
}

export interface HoldClass {
    code: "A" | "B" | "C" | "unclassified";
    name: string;
    text: string;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The class of a hold that sat out its bound. */
export const classifyHold = (facts: HoldFacts): HoldClass => {
    const { boundAt, atBound } = facts;
    const by = (at: number | undefined): at is number =>
        at !== undefined && at <= boundAt;
    const later = [
        facts.receivedAt !== undefined && !by(facts.receivedAt)
            ? `arrived at ${seconds(facts.receivedAt)}`
            : undefined,
        facts.committedAt !== undefined && !by(facts.committedAt)
            ? `committed at ${seconds(facts.committedAt)}`
            : undefined,
    ].filter((text) => text !== undefined);
    const afterBound =
        facts.committedAt !== undefined && !by(facts.committedAt)
            ? `after the bound it ${later.join(" and ")}`
            : `it had ${later.length ? `${later.join(" and ")} but not ` : "not "}committed when the diagnosis gave up at ${seconds(facts.endAt)}`;
    if (by(facts.committedAt) || atBound.inIndex === true) {
        const after = by(facts.committedAt)
            ? facts.commitDiagnostics.filter((t) => t >= facts.committedAt!)
                  .length
            : 0;
        return {
            code: "A",
            name: "hold detection did not fire",
            text: by(facts.committedAt)
                ? `the label committed at ${seconds(facts.committedAt)}, but no commit diagnostic released the hold after its change event (${facts.commitDiagnostics.length} diagnostics, ${after} after it; ${facts.clobbered} later change events reset the match)`
                : "the label was in the joiner's index at the bound, but no change event carried it",
        };
    }
    if (by(facts.receivedAt) || atBound.inLog === true) {
        const call = facts.canPerform;
        const check =
            call === undefined || call.startAt > boundAt
                ? "canPerformEntry had not run for it"
                : call.endAt === undefined || call.endAt > boundAt
                  ? `its canPerformEntry was pending from ${seconds(call.startAt)}`
                  : `its canPerformEntry returned ${call.result} at ${seconds(call.endAt)}`;
        return {
            code: "C",
            name: "joiner commit",
            text: `${by(facts.receivedAt) ? `the joiner received the label at ${seconds(facts.receivedAt)}` : "the label was in the joiner's log at the bound (by a path not recorded)"} but had not committed it by the bound: ${check}; joining ${atBound.joining}, in log ${atBound.inLog}; ${afterBound}`,
        };
    }
    if (facts.label.hash === undefined) {
        return {
            code: "unclassified",
            name: "label hash unknown",
            text: "the donor's change event for the label was not seen, so its delivery cannot be followed",
        };
    }
    return {
        code: "B",
        name: "delivery liveness, upstream",
        text: `no exchange message carried the label to the joiner by the bound and its log lacked it (${facts.namedAt !== undefined ? `a ${facts.namedBy} named it at ${seconds(facts.namedAt)}` : "no message named it"}; connections ${atBound.connections}, joiner sees donor ${atBound.joinerSeesDonor}, donor sees joiner ${atBound.donorSeesJoiner}); ${afterBound}`,
    };
};

const within = async <T>(read: () => Promise<T> | T): Promise<Read<T>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve().then(read),
            new Promise<"timeout">((resolve) => {
                timer = setTimeout(() => resolve("timeout"), READ_MS);
            }),
        ]);
    } catch {
        return "error";
    } finally {
        clearTimeout(timer);
    }
};

const hashesOf = (heads: unknown): string[] =>
    Array.isArray(heads)
        ? heads.map((head: any) => head?.hash ?? head?.entry?.hash)
        : [];

/**
 * Records a diagnosed hold of `documents`, the joiner's store, from the
 * start of its open: the label's arrival at the joiner's shared log and its
 * canPerformEntry. The hold reports its change events and commit
 * diagnostics; `fail` diagnoses a bound that expired. `stop` undoes it.
 */
export const diagnoseHold = (
    documents: any,
    options: {
        /** The joiner. */
        peer: Peerbit;
        donor: { peer: Peerbit; fs: SharedFsHandle };
        label: Label;
    }
) => {
    const { peer, donor, label } = options;
    const started = performance.now();
    const since = () => Math.round(performance.now() - started);
    const facts: Omit<HoldFacts, "boundAt" | "endAt" | "atBound" | "atEnd"> = {
        label,
        holdAt: 0,
        commitDiagnostics: [],
        changes: 0,
        clobbered: 0,
    };
    let labelCommitted!: () => void;
    const committed = new Promise<void>(
        (resolve) => (labelCommitted = resolve)
    );
    const loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
    const undo: Array<() => void> = [() => loop.disable()];

    // Every message to the joiner's shared log passes onMessage: raw heads
    // carry `hash`, decoded ones `entry.hash`; sync offers name `hashes`.
    const sharedLog = documents.log;
    const ownOnMessage = Object.hasOwn(sharedLog, "onMessage");
    const onMessage = sharedLog.onMessage;
    const watchMessage = function (
        this: unknown,
        message: any,
        ...rest: any[]
    ) {
        if (label.hash !== undefined) {
            const type = message?.constructor?.name;
            if (
                facts.receivedAt === undefined &&
                hashesOf(message?.heads).includes(label.hash)
            ) {
                facts.receivedAt = since();
                facts.receivedBy = type;
            }
            if (
                facts.namedAt === undefined &&
                Array.isArray(message?.hashes) &&
                message.hashes.includes(label.hash)
            ) {
                facts.namedAt = since();
                facts.namedBy = type;
            }
        }
        return onMessage.call(this, message, ...rest);
    };
    sharedLog.onMessage = watchMessage;
    undo.push(() => {
        if (sharedLog.onMessage !== watchMessage) return;
        if (ownOnMessage) sharedLog.onMessage = onMessage;
        else delete sharedLog.onMessage;
    });

    // Wrapped by hand, not vi.spyOn, so a spy a test already has stays.
    const prototype = SharedFileSystem.prototype as any;
    const canPerformEntry = prototype.canPerformEntry;
    const watchCanPerform = function (this: any, operation: any) {
        const result = canPerformEntry.call(this, operation);
        if (
            this.node === peer &&
            facts.canPerform === undefined &&
            label.hash !== undefined &&
            operation?.entry?.hash === label.hash
        ) {
            const call: NonNullable<HoldFacts["canPerform"]> = {
                startAt: since(),
            };
            facts.canPerform = call;
            Promise.resolve(result).then(
                (value) => {
                    call.endAt = since();
                    call.result = String(value);
                },
                (error) => {
                    call.endAt = since();
                    call.result = `a throw (${error?.message ?? error})`;
                }
            );
        }
        return result;
    };
    prototype.canPerformEntry = watchCanPerform;
    undo.push(() => {
        if (prototype.canPerformEntry === watchCanPerform) {
            prototype.canPerformEntry = canPerformEntry;
        }
    });

    // Every read is bounded and caught: a snapshot never throws or hangs.
    const snapshot = async (): Promise<HoldSnapshot> => {
        const log = sharedLog.log;
        const hash = label.hash;
        const id = label.id;
        const [
            inLog,
            joining,
            inIndex,
            connections,
            joinerSeesDonor,
            donorSeesJoiner,
        ] = await Promise.all([
            hash === undefined
                ? ("unknown" as const)
                : within(() => log.has(hash) as Promise<boolean>),
            hash === undefined
                ? ("unknown" as const)
                : within(() => Boolean(log._joining?.has?.(hash))),
            id === undefined
                ? ("unknown" as const)
                : within(
                      async () =>
                          (await documents.index.get(id, {
                              local: true,
                              remote: false,
                          })) !== undefined
                  ),
            within(
                () =>
                    peer.libp2p.getConnections(donor.peer.peerId)
                        .length as number
            ),
            within(async () =>
                (await sharedLog.getReplicators()).has(
                    donor.peer.identity.publicKey.hashcode()
                )
            ),
            within(async () =>
                (
                    await (donor.fs.program as any).entries.log.getReplicators()
                ).has(peer.identity.publicKey.hashcode())
            ),
        ]);
        return {
            at: since(),
            inLog,
            joining,
            inIndex,
            connections,
            joinerSeesDonor,
            donorSeesJoiner,
        };
    };

    return {
        /** The hold, with its bound, starts now. */
        holdStarted: () => {
            facts.holdAt = since();
        },
        /** A change event; `matched`: it carried the label. */
        onChange: (matched: boolean, wasPending: boolean) => {
            facts.changes++;
            if (matched) {
                facts.committedAt ??= since();
                labelCommitted();
            } else if (wasPending) {
                facts.clobbered++;
            }
        },
        onCommitDiagnostic: () => {
            facts.commitDiagnostics.push(since());
        },
        /**
         * The bound expired: snapshots, keeps the open running until the
         * label commits (or `released`, the hold's own detection) or
         * HOLD_TOTAL_MS after the hold started, and returns the error the
         * hold fails with.
         */
        fail: async (released: Promise<void>): Promise<Error> => {
            const boundAt = since();
            try {
                const atBound = await snapshot();
                let giveUp: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([
                    committed,
                    released,
                    new Promise<void>((resolve) => {
                        giveUp = setTimeout(
                            resolve,
                            Math.max(0, facts.holdAt + HOLD_TOTAL_MS - since())
                        );
                    }),
                ]);
                clearTimeout(giveUp);
                const endAt = since();
                const atEnd = await snapshot();
                const all: HoldFacts = {
                    ...facts,
                    boundAt,
                    endAt,
                    atBound,
                    atEnd,
                    loopDelayMaxMs: Math.round(loop.max / 1e6),
                };
                const { code, name, text } = classifyHold(all);
                return new Error(
                    `no history arrived during open: class ${code} (${name}): ${text}. Facts, in ms since the store open started: ${JSON.stringify(all)}`
                );
            } catch (error: any) {
                return new Error(
                    `no history arrived during open (the diagnosis failed: ${error?.message ?? error})`
                );
            }
        },
        stop: () => {
            for (const step of undo.splice(0).reverse()) step();
        },
    };
};
