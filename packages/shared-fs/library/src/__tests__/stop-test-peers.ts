// Test cleanup only. Drain first so a failed hook cannot stop a peer twice.
// The async callback also captures synchronous throws without skipping peers.
export async function stopTestPeers(
    peers: Array<{ stop(): unknown }>
): Promise<void> {
    const results = await Promise.allSettled(
        peers.splice(0).map(async (peer) => {
            await peer.stop();
        })
    );
    const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length)
        throw new AggregateError(errors, "Shared-fs test peer shutdown failed");
}
