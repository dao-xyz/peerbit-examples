import { describe, expect, it } from "vitest";
import {
    FairTransferOwner,
    FairTransferScheduler,
} from "../transfer-scheduling.js";

const delay = (ms = 0) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("fair transfer scheduling", () => {
    it("shares one count and byte budget across 32 owners", async () => {
        const scheduler = new FairTransferScheduler(8, 4 * 1024);
        const owners = Array.from(
            { length: 32 },
            (_, index) => new FairTransferOwner(scheduler, `owner-${index}`)
        );
        let activeCount = 0;
        let activeBytes = 0;
        let peakCount = 0;
        let peakBytes = 0;
        const started: number[] = [];

        await Promise.all(
            owners.map((owner, index) =>
                owner.enqueue(512, async () => {
                    activeCount += 1;
                    activeBytes += 512;
                    peakCount = Math.max(peakCount, activeCount);
                    peakBytes = Math.max(peakBytes, activeBytes);
                    started.push(index);
                    try {
                        await delay(2);
                    } finally {
                        activeCount -= 1;
                        activeBytes -= 512;
                    }
                })
            )
        );
        await Promise.all(owners.map((owner) => owner.drain()));

        expect(new Set(started).size).toBe(32);
        expect(peakCount).toBe(8);
        expect(peakBytes).toBe(4 * 1024);
        expect(scheduler.snapshot).toMatchObject({
            activeCount: 0,
            activeBytes: 0,
            peakCount: 8,
            peakBytes: 4 * 1024,
            queuedCount: 0,
        });
    });

    it("rotates a previously served owner behind a newly waiting owner", async () => {
        const scheduler = new FairTransferScheduler(1, 1);
        const ownerA = new FairTransferOwner(scheduler, "a");
        const ownerB = new FairTransferOwner(scheduler, "b");
        const firstA = await ownerA.acquire(1);
        const order: string[] = [];
        const secondA = ownerA.acquire(1).then((permit) => {
            order.push("a");
            return permit;
        });
        const firstB = ownerB.acquire(1).then((permit) => {
            order.push("b");
            return permit;
        });

        firstA.release();
        const permitB = await firstB;
        expect(order).toEqual(["b"]);
        permitB.release();
        const permitA = await secondA;
        expect(order).toEqual(["b", "a"]);
        permitA.release();
    });

    it("reserves capacity for a large head request instead of starving it", async () => {
        const scheduler = new FairTransferScheduler(4, 4);
        const small = new FairTransferOwner(scheduler, "small");
        const large = new FairTransferOwner(scheduler, "large");
        const newcomer = new FairTransferOwner(scheduler, "newcomer");
        const occupied = await Promise.all([
            small.acquire(1),
            small.acquire(1),
            small.acquire(1),
        ]);
        const order: string[] = [];
        const largeRequest = large.acquire(4).then((permit) => {
            order.push("large");
            return permit;
        });
        const smallContinuation = newcomer.acquire(1).then((permit) => {
            order.push("small");
            return permit;
        });

        for (const permit of occupied) {
            permit.release();
            await Promise.resolve();
        }
        const largePermit = await largeRequest;
        expect(order).toEqual(["large"]);
        largePermit.release();
        const smallPermit = await smallContinuation;
        expect(order).toEqual(["large", "small"]);
        smallPermit.release();
    });

    it("rotates past a saturated lane without reserving free shared capacity", async () => {
        const scheduler = new FairTransferScheduler(4, 4, {
            remote: 1,
            local: 4,
        });
        const activeRemote = new FairTransferOwner(scheduler, "active-remote");
        const waitingRemote = new FairTransferOwner(
            scheduler,
            "waiting-remote"
        );
        const local = new FairTransferOwner(scheduler, "local");
        const heldRemote = await activeRemote.acquire(1, "remote");
        let waitingRemoteGranted = false;

        const queuedRemote = waitingRemote
            .acquire(1, "remote")
            .then((permit) => {
                waitingRemoteGranted = true;
                return permit;
            });
        const localPermit = await local.acquire(1, "local");

        expect(waitingRemoteGranted).toBe(false);
        expect(scheduler.snapshot).toMatchObject({
            activeCount: 2,
            activeBytes: 2,
            queuedCount: 1,
            activeByLane: { remote: 1, local: 1 },
        });

        localPermit.release();
        heldRemote.release();
        const nextRemote = await queuedRemote;
        nextRemote.release();
    });

    it("drops a shared reservation once only its lane remains saturated", async () => {
        const scheduler = new FairTransferScheduler(2, 2, {
            remote: 1,
            local: 2,
        });
        const activeRemote = new FairTransferOwner(scheduler, "active-remote");
        const activeLocal = new FairTransferOwner(scheduler, "active-local");
        const waitingRemote = new FairTransferOwner(
            scheduler,
            "waiting-remote"
        );
        const waitingLocal = new FairTransferOwner(scheduler, "waiting-local");
        const heldRemote = await activeRemote.acquire(1, "remote");
        const heldLocal = await activeLocal.acquire(1, "local");
        let waitingRemoteGranted = false;
        const queuedRemote = waitingRemote
            .acquire(1, "remote")
            .then((permit) => {
                waitingRemoteGranted = true;
                return permit;
            });
        const queuedLocal = waitingLocal.acquire(1, "local");

        heldLocal.release();
        const nextLocal = await queuedLocal;
        expect(waitingRemoteGranted).toBe(false);
        expect(scheduler.snapshot.activeByLane).toEqual({
            remote: 1,
            local: 1,
        });

        nextLocal.release();
        heldRemote.release();
        const nextRemote = await queuedRemote;
        nextRemote.release();
    });

    it("does not reserve a head blocked by both shared and lane capacity", async () => {
        const scheduler = new FairTransferScheduler(4, 4, {
            remote: 1,
            local: 4,
        });
        const activeRemote = new FairTransferOwner(scheduler, "active-remote");
        const activeLocal = new FairTransferOwner(scheduler, "active-local");
        const waitingRemote = new FairTransferOwner(
            scheduler,
            "waiting-remote"
        );
        const waitingLocal = new FairTransferOwner(scheduler, "waiting-local");
        const heldRemote = await activeRemote.acquire(1, "remote");
        const heldLocal = await activeLocal.acquire(3, "local");
        let remoteGranted = false;
        const queuedRemote = waitingRemote
            .acquire(1, "remote")
            .then((permit) => {
                remoteGranted = true;
                return permit;
            });
        const queuedLocal = waitingLocal.acquire(1, "local");

        heldLocal.release();
        const localPermit = await queuedLocal;
        expect(remoteGranted).toBe(false);
        expect(scheduler.snapshot).toMatchObject({
            activeCount: 2,
            activeBytes: 2,
            queuedCount: 1,
            activeByLane: { remote: 1, local: 1 },
        });

        localPermit.release();
        heldRemote.release();
        const remotePermit = await queuedRemote;
        remotePermit.release();
    });

    it("rejects a reservation larger than the hard byte budget", async () => {
        const scheduler = new FairTransferScheduler(2, 4);
        await expect(scheduler.acquire("too-large", 5)).rejects.toThrow(
            "bytes exceed the limit"
        );
        expect(scheduler.snapshot).toMatchObject({
            activeCount: 0,
            activeBytes: 0,
            queuedCount: 0,
        });
    });

    it("preserves detached capacity when admissions reopen", async () => {
        const scheduler = new FairTransferScheduler(2, 4);
        const oldOwner = new FairTransferOwner(scheduler, "old-owner");
        const held = await oldOwner.acquire(4);
        held.release(0, 1);
        expect(held).toMatchObject({ count: 1, bytes: 3, released: false });

        scheduler.close(new Error("lifecycle close"));
        expect(scheduler.snapshot).toMatchObject({
            activeCount: 1,
            activeBytes: 3,
            queuedCount: 0,
        });
        scheduler.reopen();

        const newOwner = new FairTransferOwner(scheduler, "new-owner");
        let granted = false;
        const queued = newOwner.acquire(2).then((permit) => {
            granted = true;
            return permit;
        });
        await Promise.resolve();
        expect(granted).toBe(false);
        expect(scheduler.snapshot.queuedCount).toBe(1);

        held.release();
        const next = await queued;
        expect(next).toMatchObject({ count: 1, bytes: 2, released: false });
        next.release();
        expect(scheduler.snapshot).toMatchObject({
            activeCount: 0,
            activeBytes: 0,
            queuedCount: 0,
        });
    });

    it("cancels cleanly before and after a grant", async () => {
        const scheduler = new FairTransferScheduler(1, 8);
        const blocker = new FairTransferOwner(scheduler, "blocker");
        const held = await blocker.acquire(4);
        const beforeController = new AbortController();
        const before = new FairTransferOwner(
            scheduler,
            "before",
            beforeController.signal
        );
        const queued = before.acquire(4);
        beforeController.abort(new Error("cancel before grant"));
        await expect(queued).rejects.toThrow("cancel before grant");
        held.release();

        const afterController = new AbortController();
        const after = new FairTransferOwner(
            scheduler,
            "after",
            afterController.signal
        );
        const granted = await after.acquire(4);
        after.addCancellationCleanup(() =>
            after.releaseLeaseAfterTasksSettle(granted)
        );
        expect(granted.released).toBe(false);
        afterController.abort(new Error("cancel after grant"));
        expect(granted.released).toBe(true);
        expect(scheduler.snapshot).toMatchObject({
            activeCount: 0,
            activeBytes: 0,
            queuedCount: 0,
        });
    });

    it("isolates one owner's failure from its siblings", async () => {
        const scheduler = new FairTransferScheduler(2, 8);
        const failing = new FairTransferOwner(scheduler, "failing");
        const healthy = new FairTransferOwner(scheduler, "healthy");
        let healthyRuns = 0;

        await failing.enqueue(4, async () => {
            throw new Error("owner failed");
        });
        await healthy.enqueue(4, async () => {
            healthyRuns += 1;
        });
        await expect(failing.drain()).rejects.toThrow("owner failed");
        await healthy.drain();
        await healthy.enqueue(4, async () => {
            healthyRuns += 1;
        });
        await healthy.drain();

        expect(healthyRuns).toBe(2);
        expect(scheduler.snapshot.activeCount).toBe(0);
    });
});
