import {
    SearchRequest,
    SearchRequestIndexed,
    StringMatch,
} from "@peerbit/document";
import { Peerbit } from "peerbit";
import { afterEach, expect, it } from "vitest";
import { FileVersion, openSharedFs } from "../index.js";

const peers: Peerbit[] = [];
const createPeer = async () => {
    const peer = await Peerbit.create();
    peers.push(peer);
    return peer;
};

afterEach(async () => {
    const results = await Promise.allSettled(
        peers.splice(0).map((peer) => peer.stop())
    );
    const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length)
        throw new AggregateError(
            errors,
            "Query compatibility peer shutdown failed"
        );
});

// Legitimate public-read compatibility only. Shared FS authenticates writers;
// this fixture adds no reader policy and makes no confidentiality claim.
it(
    "serves resolved and indexed released requests without joining filesystem entries",
    { retry: 0 },
    async () => {
        const owner = await createPeer();
        const source = await openSharedFs({
            peerbit: owner,
            rootKey: owner.identity.publicKey,
            machineLabel: "query-compatibility-source",
            bootstrap: false,
        });
        const written = await source.writeFile(
            "/compatibility.txt",
            "released query compatibility"
        );
        // writeFile returns a summary, not the full persisted FileVersion.
        const version = await source.program.entries.index.get(written.id, {
            local: true,
            remote: false,
        });
        if (!(version instanceof FileVersion))
            throw new Error(
                "Source fixture is missing its stored file version"
            );
        const reader = await createPeer();
        await reader.dial(owner);
        const observer = await openSharedFs({
            peerbit: reader,
            address: source.address,
            replicate: false,
            bootstrap: false,
        });
        await observer.program.entries.waitFor(owner.identity.publicKey, {
            timeout: 5000,
        });
        const sourceHash = owner.identity.publicKey.hashcode();

        for (const resolve of [true, false]) {
            const query = [new StringMatch({ key: "id", value: version.id })];
            const request = resolve
                ? new SearchRequest({ query, fetch: 2 })
                : new SearchRequestIndexed({
                      query,
                      fetch: 2,
                      replicate: false,
                  });
            const responders: string[] = [];
            const iterator = observer.program.entries.index.iterate(request, {
                local: false,
                resolve,
                remote: {
                    from: [sourceHash],
                    replicate: false,
                    timeout: 5000,
                    throwOnMissing: true,
                    retryMissingResponses: false,
                    onResponse: (_response, from) => {
                        responders.push(from?.hashcode() ?? "missing");
                    },
                },
            });
            const errors: unknown[] = [];
            try {
                const rows = await iterator.next(2);
                expect(rows).toHaveLength(1);
                expect(rows[0]).toMatchObject({
                    id: version.id,
                    nodeId: version.nodeId,
                    contentHash: version.contentHash,
                    size: version.size,
                });
                if (resolve) {
                    const resolved = rows[0];
                    if (!(resolved instanceof FileVersion))
                        throw new Error("Expected a resolved file version");
                    expect(resolved.chunkIds).toEqual(version.chunkIds);
                } else {
                    expect(rows[0]).not.toBeInstanceOf(FileVersion);
                    expect(rows[0]).toMatchObject({
                        kind: "file-version",
                        chunkRefs: [...new Set(version.chunkIds)],
                        causalRefs: version.parentVersionIds,
                    });
                }
                expect(iterator.done()).toBe(true);
                expect(responders).toEqual([sourceHash]);
            } catch (error) {
                errors.push(error);
            }
            try {
                await iterator.close();
            } catch (error) {
                errors.push(error);
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1)
                throw new AggregateError(
                    errors,
                    "Query assertion and iterator cleanup failed"
                );
        }

        expect(await observer.program.entries.index.getSize()).toBe(0);
        expect(observer.program.entries.log.log.length).toBe(0);
        expect(
            await observer.program.entries.log.getMyReplicationSegments()
        ).toEqual([]);
    }
);
