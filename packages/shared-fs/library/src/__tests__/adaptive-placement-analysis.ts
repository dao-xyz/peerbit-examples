export interface PlacementChunk {
    id: string;
    bytes: number;
}

export interface PlacementMetadata {
    id: string;
    chunkIds: readonly string[];
    chunkBytes: readonly number[];
    bytes: number;
    hash: string;
}

export interface PlacementSnapshot {
    peer: number;
    role: "publisher" | "custodian";
    capacityBytes: number | null;
    participation: number;
    localLogBytes: number;
    chunks: readonly PlacementChunk[];
    metadata: readonly PlacementMetadata[];
}

const semantics =
    "Observed logical chunk residency; not network bytes or proof of persisted durability";
const byId = (left: { id: string }, right: { id: string }) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

const integer = (value: number, label: string) => {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a nonnegative safe integer`);
    }
};

const identifier = (value: string, label: string) => {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label} must be a nonempty string`);
    }
};

const sumBytes = (values: readonly number[]) => {
    const total = values.reduce((sum, value) => sum + value, 0);
    integer(total, "Summed bytes");
    return total;
};

const addChunk = (chunks: Map<string, number>, chunk: PlacementChunk) => {
    identifier(chunk.id, "Chunk ID");
    integer(chunk.bytes, "Chunk bytes");
    const known = chunks.get(chunk.id);
    if (known !== undefined && known !== chunk.bytes) {
        throw new Error(`Conflicting chunk size: ${chunk.id}`);
    }
    chunks.set(chunk.id, chunk.bytes);
};

const manifestKey = (metadata: PlacementMetadata) =>
    JSON.stringify([
        metadata.chunkIds,
        metadata.chunkBytes,
        metadata.bytes,
        metadata.hash,
    ]);

const addMetadata = (
    manifests: Map<string, PlacementMetadata>,
    chunks: Map<string, number>,
    metadata: PlacementMetadata
) => {
    identifier(metadata.id, "Metadata ID");
    identifier(metadata.hash, "Metadata hash");
    integer(metadata.bytes, "Metadata file bytes");
    if (
        !Array.isArray(metadata.chunkIds) ||
        !Array.isArray(metadata.chunkBytes) ||
        metadata.chunkIds.length !== metadata.chunkBytes.length
    ) {
        throw new Error(`Misaligned metadata chunks: ${metadata.id}`);
    }
    for (let index = 0; index < metadata.chunkIds.length; index++) {
        addChunk(chunks, {
            id: metadata.chunkIds[index],
            bytes: metadata.chunkBytes[index],
        });
    }
    if (sumBytes(metadata.chunkBytes) !== metadata.bytes) {
        throw new Error(`Metadata file size mismatch: ${metadata.id}`);
    }
    const known = manifests.get(metadata.id);
    if (known && manifestKey(known) !== manifestKey(metadata)) {
        throw new Error(`Conflicting metadata: ${metadata.id}`);
    }
    manifests.set(metadata.id, metadata);
};

const uniqueIds = (items: readonly { id: string }[], label: string) => {
    if (!Array.isArray(items)) throw new Error(`${label} must be an array`);
    if (new Set(items.map((item) => item.id)).size !== items.length) {
        throw new Error(`Duplicate ${label} ID`);
    }
};

// Also used by comparisons without requiring every peer to have metadata yet.
const validateSnapshots = (snapshots: readonly PlacementSnapshot[]) => {
    if (!Array.isArray(snapshots as unknown))
        throw new Error("Snapshots must be an array");
    const peers = new Set<number>();
    const chunks = new Map<string, number>();
    const manifests = new Map<string, PlacementMetadata>();
    for (const snapshot of snapshots) {
        integer(snapshot.peer, "Peer ID");
        if (peers.has(snapshot.peer))
            throw new Error("Duplicate peer identity");
        peers.add(snapshot.peer);
        if (!["publisher", "custodian"].includes(snapshot.role)) {
            throw new Error("Unknown peer role");
        }
        if (snapshot.capacityBytes !== null) {
            integer(snapshot.capacityBytes, "Capacity bytes");
        }
        if (
            !Number.isFinite(snapshot.participation) ||
            snapshot.participation < 0
        ) {
            throw new Error("Participation must be finite and nonnegative");
        }
        integer(snapshot.localLogBytes, "Local log bytes");
        uniqueIds(snapshot.chunks, "local chunk");
        uniqueIds(snapshot.metadata, "local metadata");
        for (const chunk of snapshot.chunks) addChunk(chunks, chunk);
        sumBytes(snapshot.chunks.map((chunk) => chunk.bytes));
        for (const metadata of snapshot.metadata) {
            addMetadata(manifests, chunks, metadata);
        }
    }
    return { chunks, manifests };
};

export const analyzePlacement = (
    snapshots: readonly PlacementSnapshot[],
    expectedMetadata: readonly PlacementMetadata[],
    spec: { minCopies: number }
) => {
    integer(spec.minCopies, "Minimum copies");
    if (spec.minCopies === 0)
        throw new Error("Minimum copies must be positive");
    validateSnapshots(snapshots);
    uniqueIds(expectedMetadata, "expected metadata");
    const expected = new Map<string, PlacementMetadata>();
    const chunks = new Map<string, number>();
    for (const metadata of expectedMetadata)
        addMetadata(expected, chunks, metadata);
    for (const snapshot of snapshots) {
        for (const chunk of snapshot.chunks) {
            if (!chunks.has(chunk.id))
                throw new Error(`Unknown chunk: ${chunk.id}`);
            if (chunks.get(chunk.id) !== chunk.bytes) {
                throw new Error(`Conflicting chunk size: ${chunk.id}`);
            }
        }
        for (const metadata of snapshot.metadata) {
            const known = expected.get(metadata.id);
            if (!known) throw new Error(`Unknown metadata: ${metadata.id}`);
            if (manifestKey(known) !== manifestKey(metadata)) {
                throw new Error(`Conflicting metadata: ${metadata.id}`);
            }
        }
    }
    const orderedPeers = [...snapshots].sort((a, b) => a.peer - b.peer);
    const residency = new Map(
        orderedPeers.map((snapshot) => [
            snapshot.peer,
            new Set(snapshot.chunks.map((chunk) => chunk.id)),
        ])
    );
    const copiesByChunk = [...chunks]
        .map(([id, bytes]) => {
            const custodians = orderedPeers
                .filter(
                    (peer) =>
                        peer.role === "custodian" &&
                        residency.get(peer.peer)!.has(id)
                )
                .map((peer) => peer.peer);
            return { id, bytes, copies: custodians.length, custodians };
        })
        .sort(byId);
    const totalBytes = sumBytes([...chunks.values()]);
    const coverage = (minimum: number) => {
        const covered = copiesByChunk.filter(
            (chunk) => chunk.copies >= minimum
        );
        const bytes = sumBytes(covered.map((chunk) => chunk.bytes));
        return {
            chunks: covered.length,
            bytes,
            countFraction: chunks.size ? covered.length / chunks.size : null,
            byteFraction: totalBytes ? bytes / totalBytes : null,
        };
    };
    return {
        semantics,
        minCopies: spec.minCopies,
        expectedMetadataCount: expected.size,
        expectedChunkCount: chunks.size,
        expectedUniquePayloadBytes: totalBytes,
        missingMetadataByPeer: orderedPeers.map((snapshot) => {
            const present = new Set(
                snapshot.metadata.map((metadata) => metadata.id)
            );
            return {
                peer: snapshot.peer,
                ids: [...expected.keys()]
                    .filter((id) => !present.has(id))
                    .sort(),
            };
        }),
        copiesByChunk,
        belowMinCopies: copiesByChunk.filter(
            (chunk) => chunk.copies < spec.minCopies
        ),
        coverage: {
            anyCustodian: coverage(1),
            minCopies: coverage(spec.minCopies),
        },
        peers: orderedPeers.map((snapshot) => {
            const logicalPayloadBytes = sumBytes(
                snapshot.chunks.map((chunk) => chunk.bytes)
            );
            const overage = (bytes: number) =>
                snapshot.capacityBytes === null
                    ? null
                    : Math.max(0, bytes - snapshot.capacityBytes);
            return {
                peer: snapshot.peer,
                role: snapshot.role,
                participation: snapshot.participation,
                capacityBytes: snapshot.capacityBytes,
                chunks: snapshot.chunks.length,
                metadata: snapshot.metadata.length,
                logicalPayloadBytes,
                localLogBytes: snapshot.localLogBytes,
                // These measurements can overlap; never add them as disk usage.
                payloadTargetOverageBytes: overage(logicalPayloadBytes),
                logTargetOverageBytes: overage(snapshot.localLogBytes),
            };
        }),
        capacitySemantics:
            "Soft target only, not an enforced hard quota; payload and log bytes reported separately",
    };
};

export const comparePlacement = (
    previous: readonly PlacementSnapshot[],
    next: readonly PlacementSnapshot[]
) => {
    const before = validateSnapshots(previous);
    const after = validateSnapshots(next);
    for (const [id, bytes] of after.chunks)
        addChunk(before.chunks, { id, bytes });
    for (const metadata of after.manifests.values()) {
        addMetadata(before.manifests, before.chunks, metadata);
    }
    const oldPeers = new Map(
        previous.map((snapshot) => [snapshot.peer, snapshot])
    );
    const newPeers = new Map(next.map((snapshot) => [snapshot.peer, snapshot]));
    const peers = [...new Set([...oldPeers.keys(), ...newPeers.keys()])]
        .sort((a, b) => a - b)
        .map((peer) => {
            const oldPeer = oldPeers.get(peer);
            const newPeer = newPeers.get(peer);
            const oldChunks = new Map(
                oldPeer?.chunks.map((chunk) => [chunk.id, chunk.bytes])
            );
            const newChunks = new Map(
                newPeer?.chunks.map((chunk) => [chunk.id, chunk.bytes])
            );
            const additions = [...newChunks]
                .filter(([id]) => !oldChunks.has(id))
                .map(([id, bytes]) => ({ id, bytes }))
                .sort(byId);
            const removals = [...oldChunks]
                .filter(([id]) => !newChunks.has(id))
                .map(([id, bytes]) => ({ id, bytes }))
                .sort(byId);
            return {
                peer,
                membership: !oldPeer ? "joined" : !newPeer ? "left" : "present",
                previousRole: oldPeer?.role ?? null,
                nextRole: newPeer?.role ?? null,
                additions,
                removals,
                addedBytes: sumBytes(additions.map((chunk) => chunk.bytes)),
                removedBytes: sumBytes(removals.map((chunk) => chunk.bytes)),
            };
        });
    return {
        semantics,
        membershipSemantics:
            "Joins/leaves change observed membership; absence does not prove physical block deletion",
        joinedPeers: peers
            .filter((peer) => peer.membership === "joined")
            .map((peer) => peer.peer),
        leftPeers: peers
            .filter((peer) => peer.membership === "left")
            .map((peer) => peer.peer),
        peers,
        addedBytes: sumBytes(peers.map((peer) => peer.addedBytes)),
        removedBytes: sumBytes(peers.map((peer) => peer.removedBytes)),
    };
};
