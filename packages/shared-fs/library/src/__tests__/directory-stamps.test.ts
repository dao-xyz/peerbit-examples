import { describe, expect, it } from "vitest";
import { CONFLICTS_STAMP_KEY, DirectoryStamps } from "../directory-stamps.js";

const second = (ms: number) => Math.floor(ms / 1000);

describe("directory change stamps", () => {
    it("reads in a later second than construction and repeats a value until bumped", () => {
        let now = 50_000;
        const stamps = new DirectoryStamps({ now: () => now });
        now = 49_000; // a clock stepping backwards must not matter
        const root = stamps.read("root");
        expect(second(root)).toBeGreaterThan(second(50_000));
        now = 60_000;
        expect(stamps.read("root")).toBe(root);
    });

    it("issues each key's values from the clock, unmoved by other keys", () => {
        let now = 9_000;
        const stamps = new DirectoryStamps({ now: () => now });
        const keys = ["root", "dir:a", "dir:b", CONFLICTS_STAMP_KEY];
        now = 100_000;
        // A burst of first reads (find, readdir-plus) stays at the clock.
        expect(keys.map((key) => stamps.read(key))).toEqual(
            keys.map(() => 100_000)
        );
        for (const key of keys) stamps.bump(key);
        for (const key of keys) {
            expect(stamps.read(key)).toBe(101_000);
        }
    });

    it("moves a key to the next second although another key ran ahead", () => {
        let now = 9_000;
        const stamps = new DirectoryStamps({ now: () => now });
        now = 10_100;
        expect(stamps.read("dir:d")).toBe(10_100);
        now = 10_200;
        stamps.bump("dir:d"); // a create in d: 11_000, a second ahead
        expect(stamps.read("dir:d")).toBe(11_000);
        now = 10_300;
        // git lstats e, then reads it: e is not pushed into d's second.
        const recorded = stamps.read("dir:e");
        expect(recorded).toBe(10_300);
        now = 10_400;
        stamps.bump("dir:e"); // a file created in e
        const changed = stamps.read("dir:e");
        expect(second(changed)).toBeGreaterThan(second(recorded));
        expect(changed).toBeLessThanOrEqual(now + 1000);
    });

    it("moves a bumped, handed-out value to the next whole second", () => {
        let now = 99_000;
        const stamps = new DirectoryStamps({ now: () => now });
        now = 100_200;
        expect(stamps.read("dir:d")).toBe(100_200);
        now = 100_500;
        stamps.bump("dir:d");
        expect(stamps.read("dir:d")).toBe(101_000);
    });

    it("bumps a value nobody read, or an unknown key, to the clock without a jump", () => {
        let now = 99_000;
        const stamps = new DirectoryStamps({ now: () => now });
        now = 100_200;
        stamps.read("dir:d");
        now = 100_500;
        stamps.bump("dir:d"); // 101_000, not handed out yet
        now = 101_300;
        stamps.bump("dir:d");
        expect(stamps.read("dir:d")).toBe(101_300);

        // An unknown key needs no state: its first read is simply fresh.
        now = 102_400;
        stamps.bump("dir:never-read");
        expect(stamps.read("dir:never-read")).toBe(102_400);
    });

    it("stays within one second of a clock that advances under read and bump cycling", () => {
        let now = 99_000;
        const stamps = new DirectoryStamps({ now: () => now });
        now = 100_000;
        const values: number[] = [];
        for (let cycle = 0; cycle < 2_000; cycle++) {
            const value = stamps.read("dir:hot");
            expect(value).toBeLessThanOrEqual(now + 1000);
            values.push(value);
            stamps.bump("dir:hot");
            now++;
        }
        for (let i = 1; i < values.length; i++) {
            expect(values[i]).toBeGreaterThan(values[i - 1]);
        }
        // One jump to the next second, then 1 ms steps until the clock is
        // within a second of the next boundary and the jumps resume.
        expect(values[1]).toBe(101_000);
        expect(values.filter((value) => value % 1000 === 0)).toEqual([
            100_000, 101_000, 102_000,
        ]);
    });

    it("never runs more than a second ahead under several read and bump cycles per millisecond", () => {
        let now = 99_000;
        const stamps = new DirectoryStamps({ now: () => now });
        now = 100_000;
        let last = stamps.read("dir:hot");
        for (let ms = 0; ms < 3_000; ms++) {
            for (let cycle = 0; cycle < 3; cycle++) {
                stamps.bump("dir:hot");
                const value = stamps.read("dir:hot");
                expect(value).toBeGreaterThanOrEqual(last);
                expect(value).toBeLessThanOrEqual(now + 1000);
                last = value;
            }
            now++;
            // The first read after the clock moved shows the change the cap
            // held back in the previous millisecond.
            const moved = stamps.read("dir:hot");
            expect(moved).toBeGreaterThan(last);
            expect(moved).toBeLessThanOrEqual(now + 1000);
            last = moved;
        }
        // Held at the cap: the lead never grew past a second.
        expect(last).toBe(now + 1000);
    });

    it("keeps a change the cap holds back at the value read until the clock moves", () => {
        let now = 99_000;
        const stamps = new DirectoryStamps({ now: () => now });
        now = 100_000;
        stamps.read("dir:d");
        // Changes, each read, within one millisecond: the first jumps to
        // 101_000, a full second ahead, so the next one cannot move.
        stamps.bump("dir:d");
        const capped = stamps.read("dir:d");
        expect(capped).toBe(101_000);
        stamps.bump("dir:d");
        expect(stamps.read("dir:d")).toBe(capped);
        expect(stamps.read("dir:d")).toBe(capped);
        // Unchanged until the clock moves; then the next read changes
        // without another bump, and stays put.
        now++;
        const moved = stamps.read("dir:d");
        expect(moved).toBe(capped + 1);
        expect(stamps.read("dir:d")).toBe(moved);
    });

    it("keeps a value changed twice within a second in the second it jumped to", () => {
        let now = 99_000;
        const stamps = new DirectoryStamps({ now: () => now });
        now = 20_000 + 100_000;
        const first = stamps.read("dir:d");
        now += 300;
        stamps.bump("dir:d");
        const ahead = stamps.read("dir:d");
        expect(ahead).toBe(second(first) * 1000 + 1000);
        // A further change in the same wall second cannot reach the second
        // after that without running more than a second ahead.
        now += 100;
        stamps.bump("dir:d");
        expect(stamps.read("dir:d")).toBe(ahead + 1);
    });

    it("reissues every key after bumpAll, above and a second past earlier values", () => {
        let now = 199_000;
        const stamps = new DirectoryStamps({ now: () => now });
        now = 200_100;
        const before = ["root", "dir:a", CONFLICTS_STAMP_KEY].map((key) =>
            stamps.read(key)
        );
        now = 200_300;
        stamps.bumpAll();
        const after = ["root", "dir:a", CONFLICTS_STAMP_KEY].map((key) =>
            stamps.read(key)
        );
        for (const value of after) {
            expect(value).toBeGreaterThan(Math.max(...before));
            expect(second(value)).toBeGreaterThan(second(Math.max(...before)));
        }
        // Stable again until the next change.
        expect(stamps.read("dir:a")).toBe(after[1]);
    });

    it("re-seeds an evicted key in a later second than any value handed out", () => {
        let now = 300_000;
        const stamps = new DirectoryStamps({ now: () => now, limit: 10 });
        const handedOut: number[] = [];
        for (let i = 0; i <= 10; i++) {
            handedOut.push(stamps.read(`dir:${i}`));
        }
        // The eleventh key evicted the oldest tenth (dir:0, dir:1). A later
        // second is more than a second ahead of the clock until it moves.
        const held = stamps.read("dir:0");
        expect(held).toBeLessThanOrEqual(now + 1000);
        expect(stamps.read("dir:0")).toBe(held);
        now += 1000;
        const reseeded = stamps.read("dir:0");
        expect(second(reseeded)).toBeGreaterThan(
            second(Math.max(...handedOut))
        );
        expect(reseeded).toBeLessThanOrEqual(now + 1000);
        // Surviving keys keep their values.
        expect(stamps.read("dir:10")).toBe(handedOut[10]);
    });

    it("starts a remount past every value a mount handed out in a burst", () => {
        const start = 1_700_000_000_000;
        let now = start - 500;
        const first = new DirectoryStamps({ now: () => now });
        now = start;
        // Three name changes, each observed, per millisecond for a second.
        let handedOut = first.read("dir:d");
        for (let ms = 0; ms < 1_000; ms++, now++) {
            for (let cycle = 0; cycle < 3; cycle++) {
                first.bump("dir:d");
                handedOut = Math.max(handedOut, first.read("dir:d"));
            }
        }
        const stoppedAt = now;
        expect(handedOut).toBeLessThanOrEqual(stoppedAt + 1000);
        // Mounted again a second after it stopped.
        now = stoppedAt + 1000;
        const remounted = new DirectoryStamps({ now: () => now });
        const reread = remounted.read("dir:d");
        expect(reread).toBeGreaterThan(handedOut);
        expect(reread).toBeLessThanOrEqual(now + 1000);
    });

    it("starts a remount past every value of a mount that stopped a second earlier", () => {
        let now = 9_000;
        const first = new DirectoryStamps({ now: () => now });
        now = 10_100;
        first.read("dir:d");
        now = 10_200;
        first.bump("dir:d");
        const handedOut = first.read("dir:d"); // 11_000, a second ahead
        // Unmounted at 10_200; mounted again a second later.
        now = 11_200;
        const remounted = new DirectoryStamps({ now: () => now });
        const reread = remounted.read("dir:d");
        expect(second(reread)).toBeGreaterThan(second(handedOut));
        expect(reread).toBeLessThanOrEqual(now + 1000);
    });

    it("starts a directory that replaced another at its path past the replaced one's value", () => {
        let now = 9_000;
        const stamps = new DirectoryStamps({ now: () => now });
        now = 10_100;
        const old = stamps.read("dir:old");
        // A new directory node at the same path, first read in the same
        // millisecond: its value cannot repeat the old one's.
        const replacement = stamps.read("dir:new", "dir:old");
        expect(second(replacement)).toBeGreaterThan(second(old));
        expect(stamps.read("dir:new")).toBe(replacement);

        // An existing node moved onto a path whose value shares its second.
        now = 11_100;
        const other = stamps.read("dir:other");
        const moved = stamps.read("dir:moved");
        expect(second(moved)).toBe(second(other));
        const atPath = stamps.read("dir:moved", "dir:other");
        expect(second(atPath)).toBeGreaterThan(second(other));
    });
});
