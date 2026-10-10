import type { Peerbit } from "peerbit";
import { SharedFileSystem } from "../index.js";

type MarkWriteReady = (this: any, generation: number) => Promise<void>;

interface Parked {
    program: any;
    generation: number;
    resolve: () => void;
    reject: (error: unknown) => void;
}

interface Hold {
    peer: Peerbit;
    holding: boolean;
    parked: Parked[];
}

/** Every installed hold; the prototype is patched while one exists. */
const holds = new Set<Hold>();
let original: MarkWriteReady | undefined;

const holdOf = (program: any): Hold | undefined => {
    for (const hold of holds) {
        if (program?.node === hold.peer) return hold;
    }
    return undefined;
};

const install = () => {
    if (original) return;
    const prototype = SharedFileSystem.prototype as any;
    const markWriteReady: MarkWriteReady = prototype.markWriteReady;
    original = markWriteReady;
    prototype.markWriteReady = function (this: any, generation: number) {
        const hold = holdOf(this);
        if (!hold?.holding) return markWriteReady.call(this, generation);
        return new Promise<void>((resolve, reject) =>
            hold.parked.push({ program: this, generation, resolve, reject })
        );
    };
};

const uninstall = () => {
    if (!original || holds.size > 0) return;
    (SharedFileSystem.prototype as any).markWriteReady = original;
    original = undefined;
};

/** Runs the parked calls in order, each settling its parked promise. */
const runParked = (hold: Hold) => {
    const markWriteReady = original!;
    for (const { program, generation, resolve, reject } of hold.parked.splice(
        0
    )) {
        markWriteReady.call(program, generation).then(resolve, reject);
    }
};

/**
 * Test-only: parks the write-ready decisions (SharedFileSystem's private
 * markWriteReady) of every filesystem opened on `peer` until release(),
 * so a test can hold a joiner whose predicate holds but that has not
 * flipped: what a long quiet window did before PR-3 commit 4. Install it
 * before the open. release() runs the parked calls in order and lets
 * later ones through; restore() also uninstalls. The coordinator asks
 * again after a parked call ends only if a satisfied evaluation arrived
 * meanwhile, as in production.
 */
export const holdFlips = (peer: Peerbit) => {
    const hold: Hold = { peer, holding: true, parked: [] };
    holds.add(hold);
    install();
    const release = () => {
        hold.holding = false;
        if (original) runParked(hold);
    };
    return {
        /** Decisions parked now. */
        parked: () => hold.parked.length,
        release,
        restore: () => {
            if (!holds.has(hold)) return;
            release();
            holds.delete(hold);
            uninstall();
        },
    };
};
