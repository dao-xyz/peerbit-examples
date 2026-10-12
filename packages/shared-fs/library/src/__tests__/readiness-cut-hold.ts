import type { Peerbit } from "peerbit";
import { SharedFileSystem } from "../index.js";

type OnReadinessComplete = (this: any, generation: number) => void;

interface Call {
    program: any;
    generation: number;
    /** The bootstrap phase when the call arrived. */
    phase: string;
}

interface Hold {
    peer: Peerbit;
    holding: boolean;
    calls: Call[];
}

/** Every installed hold; the prototype is patched while one exists. */
const holds = new Set<Hold>();
let original: OnReadinessComplete | undefined;

const holdOf = (program: any): Hold | undefined => {
    for (const hold of holds) {
        if (program?.node === hold.peer) return hold;
    }
    return undefined;
};

const install = () => {
    if (original) return;
    const prototype = SharedFileSystem.prototype as any;
    const onReadinessComplete: OnReadinessComplete =
        prototype.onReadinessComplete;
    original = onReadinessComplete;
    prototype.onReadinessComplete = function (this: any, generation: number) {
        const hold = holdOf(this);
        hold?.calls.push({
            program: this,
            generation,
            phase: this.bootstrapPhase,
        });
        if (hold?.holding) return;
        onReadinessComplete.call(this, generation);
    };
};

const uninstall = () => {
    if (!original || holds.size > 0) return;
    (SharedFileSystem.prototype as any).onReadinessComplete = original;
    original = undefined;
};

/**
 * Test-only: drops the bootstrap cut (SharedFileSystem's private
 * onReadinessComplete, M2 PR-2) of every filesystem opened on `peer`
 * while held, and records every call with the bootstrap phase it saw.
 * A test that pins the snapshot path or the posture of a failed bootstrap
 * holds it, so a fast readiness proof cannot end its discovery first.
 * Install it before the open. The cut is level-triggered and nothing is
 * parked: after release() the next complete evaluation cuts (a test can
 * ask for one with the readiness runtime's evaluate()). `cut(program,
 * generation)` calls the real handler directly, held or not. restore()
 * also uninstalls.
 */
export const holdCuts = (peer: Peerbit) => {
    const hold: Hold = { peer, holding: true, calls: [] };
    holds.add(hold);
    install();
    return {
        /** Every call so far, held or not. */
        calls: () => [...hold.calls],
        release: () => {
            hold.holding = false;
        },
        /** The real handler, bypassing the hold. */
        cut: (program: unknown, generation: number) =>
            (
                original ??
                (SharedFileSystem.prototype as any).onReadinessComplete
            ).call(program, generation),
        restore: () => {
            if (!holds.delete(hold)) return;
            uninstall();
        },
    };
};
