/** Stamp key shared by `/.peerbit-conflicts` and every per-path conflict directory. */
export const CONFLICTS_STAMP_KEY = "conflicts:";

/** How far a stamp may run ahead of the clock. */
const MAX_LEAD_MS = 1000;

export type DirectoryStampsOptions = {
    /** Millisecond clock; defaults to Date.now. */
    now?: () => number;
    /** Keys kept before the oldest 10% are evicted. Default 200,000. */
    limit?: number;
};

type Stamp = {
    value: number;
    /** A consumer may have recorded `value` (read since it was issued). */
    handedOut: boolean;
    /**
     * The latest value a consumer may have recorded before `value` was
     * issued, which `value` must exceed. `value` is not above it while the
     * lead cap holds a change back (see `read`).
     */
    recorded: number;
    gen: number;
};

/** The first whole second after `ms`. */
const secondAfter = (ms: number) => (Math.floor(ms / 1000) + 1) * 1000;

/** The latest value of a key that a consumer may have recorded. */
const lastRecorded = (stamp: Stamp) =>
    stamp.handedOut ? stamp.value : stamp.recorded;

/**
 * Per-mount directory change stamps: the mtime and ctime a native mount
 * reports for directories. Stamps are in-memory values from the mount's own
 * clock and are never replicated. Each key is a directory node id (`root` for
 * `/`) or CONFLICTS_STAMP_KEY.
 *
 * A key changes only when bumped or after bumpAll, and every value a consumer
 * may have recorded is followed by a larger one. Values come from the clock
 * per key, so other keys' changes never move a key ahead, and no value is
 * ever more than 1 s ahead of the clock (its latest reading: a clock that
 * steps back counts as standing still). When a bump replaces a value that was
 * handed out, the new value moves to the next whole second if that is at most
 * 1 s ahead of the clock: tools that compare whole seconds, such as git's
 * untracked cache, still see a change made in the second they recorded. A
 * key read while it is already a second ahead and changed again within that
 * second stays in that second: 1 ms later while that is at most 1 s ahead,
 * otherwise at the value read, which the first read after the clock moves on
 * replaces. git still rescans it while its index is not newer than that
 * second.
 *
 * A key's first value is in a later second than construction, so a mount
 * started at least a second after the previous one stopped never repeats
 * that mount's values. A key read again after this instance evicted it
 * starts above every value it had as soon as that is at most 1 s ahead, and
 * a directory that replaces another at the same path starts above the value
 * handed out for that one (see `read`).
 */
export class DirectoryStamps {
    private readonly entries = new Map<string, Stamp>();
    private readonly now: () => number;
    private readonly limit: number;
    /** The latest clock reading; the clock never steps back below it. */
    private latest: number;
    /** Lower bound for a key's first value; raised past evicted values. */
    private floor: number;
    private gen = 0;

    constructor(options: DirectoryStampsOptions = {}) {
        this.now = options.now ?? Date.now;
        this.limit = Math.max(1, options.limit ?? 200_000);
        this.latest = this.now();
        this.floor = secondAfter(this.latest);
    }

    private time() {
        this.latest = Math.max(this.latest, this.now());
        return this.latest;
    }

    /**
     * A value above `above`, the latest value a consumer may hold, in the
     * second after it when that is at most 1 s ahead of the clock. Never more
     * than 1 s ahead: at or below `above` when the cap leaves no room.
     */
    private issue(above: number) {
        const now = this.time();
        const cap = now + MAX_LEAD_MS;
        const next = secondAfter(above);
        return Math.min(
            Math.max(now, above + 1, next <= cap ? next : -Infinity),
            cap
        );
    }

    /**
     * The key's current value; a missing or pre-bumpAll key is (re)issued.
     * `replaces` names the key of the directory this one replaced at the
     * path being read (another node there before): the value then moves
     * past whatever was handed out for that one, to a later second when it
     * is not there already and the cap allows. A change the cap held back
     * keeps the value a consumer holds until the clock moves on.
     */
    read(key: string, replaces?: string): number {
        const entry = this.entries.get(key);
        const previous =
            replaces === undefined || replaces === key
                ? undefined
                : this.entries.get(replaces);
        const replaced = previous && lastRecorded(previous);
        if (
            entry &&
            entry.gen === this.gen &&
            (replaced === undefined || entry.value >= secondAfter(replaced))
        ) {
            if (!entry.handedOut && entry.value <= entry.recorded) {
                const value = this.issue(entry.recorded);
                if (value <= entry.recorded) {
                    return entry.value;
                }
                entry.value = value;
            }
            entry.handedOut = true;
            return entry.value;
        }
        // Above whatever a consumer may have recorded for the key before
        // bumpAll, or for the directory it replaced; a first value is at
        // least the floor.
        const recorded = Math.max(
            (entry && lastRecorded(entry)) ?? -Infinity,
            replaced ?? -Infinity
        );
        const above = Number.isFinite(recorded) ? recorded : this.floor - 1;
        const value = this.issue(above);
        this.entries.delete(key);
        this.entries.set(key, {
            value,
            handedOut: value > above,
            recorded: above,
            gen: this.gen,
        });
        this.bound();
        return value;
    }

    /**
     * The key's directory may have changed its visible names. A key that was
     * never read (or was evicted) needs nothing: its next read issues a value
     * above every earlier one.
     */
    bump(key: string): void {
        const entry = this.entries.get(key);
        if (!entry) {
            return;
        }
        const recorded = lastRecorded(entry);
        this.entries.delete(key);
        this.entries.set(key, {
            value: this.issue(recorded),
            handedOut: false,
            recorded,
            gen: this.gen,
        });
    }

    /** Every key changes on its next read (lazy reissue). */
    bumpAll(): void {
        this.gen++;
    }

    private bound() {
        if (this.entries.size <= this.limit) {
            return;
        }
        const evict = Math.ceil(this.entries.size / 10);
        let count = 0;
        for (const [key, entry] of this.entries) {
            this.entries.delete(key);
            // A consumer may hold the evicted value: a later first read of
            // the key lands in a later second.
            this.floor = Math.max(this.floor, secondAfter(lastRecorded(entry)));
            if (++count >= evict) {
                break;
            }
        }
    }
}
