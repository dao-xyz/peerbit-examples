export type FileShareStreamDiagnostics = {
    id: string | null;
    direction: string | null;
    status: string | null;
    protocol: string | null;
};

export type FileShareConnectionDiagnostics = {
    id: string | null;
    remotePeer: string | null;
    direction: string | null;
    status: string | null;
    multiplexer: string | null;
    streams: FileShareStreamDiagnostics[];
};

export type FileShareDirectBlockStreamDiagnostics = {
    remotePeer: string | null;
    id: string | null;
    direction: "inbound" | "outbound";
    bytes: number | null;
    aborted: boolean | null;
    counterStreamIdentityMatch: boolean;
    connectionIdentityMatchCount: number;
    connectionId: string | null;
    multiplexer: string | null;
};

export type FileShareTransportService = "pubsub" | "blocks" | "fanout";

export type FileShareTransportStreamDiagnostics =
    FileShareDirectBlockStreamDiagnostics & {
        service: FileShareTransportService;
        remotePeerHash: string | null;
        peerHashIdentityMatch: boolean;
        serviceProtocol: string | null;
        protocol: string | null;
        expectedProtocol: string;
        protocolIdentityMatch: boolean;
    };

const TRANSPORT_SERVICE_PROTOCOLS: ReadonlyArray<{
    service: FileShareTransportService;
    expectedProtocol: string;
}> = [
    {
        service: "pubsub",
        expectedProtocol: "/peerbit/topic-control-plane/2.0.0",
    },
    {
        service: "blocks",
        expectedProtocol: "/peerbit/direct-block/1.0.0",
    },
    {
        service: "fanout",
        expectedProtocol: "/peerbit/fanout-tree/0.5.0",
    },
];

const toDiagnosticString = (value: unknown): string | null => {
    if (value == null) {
        return null;
    }
    if (typeof value === "string") {
        return value;
    }
    try {
        const rendered = (value as { toString?: () => unknown }).toString?.();
        return typeof rendered === "string" ? rendered : null;
    } catch {
        return null;
    }
};

const compareDiagnosticRecords = (
    left: unknown,
    right: unknown,
    keys: string[]
) => {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    for (const key of keys) {
        const leftValue = String(leftRecord[key] ?? "");
        const rightValue = String(rightRecord[key] ?? "");
        if (leftValue < rightValue) {
            return -1;
        }
        if (leftValue > rightValue) {
            return 1;
        }
    }
    return 0;
};

const toDiagnosticNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;

const getTransportPeerStreams = (peer: unknown) => {
    const services = (
        peer as {
            services?: Partial<
                Record<FileShareTransportService, { peers?: unknown }>
            >;
        } | null
    )?.services;

    return TRANSPORT_SERVICE_PROTOCOLS.flatMap(
        ({ service, expectedProtocol }) => {
            const peers = services?.[service]?.peers as
                | {
                      entries?: () => Iterable<[unknown, unknown]>;
                      values?: () => Iterable<unknown>;
                  }
                | undefined;
            try {
                if (typeof peers?.entries === "function") {
                    return [...peers.entries()].map(
                        ([peerHash, peerStreams]) => ({
                            service,
                            expectedProtocol,
                            remotePeerHash: toDiagnosticString(peerHash),
                            peerStreams,
                        })
                    );
                }
                return typeof peers?.values === "function"
                    ? [...peers.values()].map((peerStreams) => ({
                          service,
                          expectedProtocol,
                          remotePeerHash: null,
                          peerStreams,
                      }))
                    : [];
            } catch {
                return [];
            }
        }
    );
};

export const getPeerConnectionDiagnostics = (peer: unknown) => {
    const peerLike = peer as {
        peerId?: unknown;
        libp2p?: {
            peerId?: unknown;
            getConnections?: () => unknown;
        };
    } | null;
    const rawConnections = peerLike?.libp2p?.getConnections?.();
    const rawConnectionList = Array.isArray(rawConnections)
        ? rawConnections
        : [];
    const connections = rawConnectionList.length
        ? rawConnectionList
              .map((rawConnection): FileShareConnectionDiagnostics => {
                  const connection = rawConnection as {
                      id?: unknown;
                      remotePeer?: unknown;
                      direction?: unknown;
                      status?: unknown;
                      multiplexer?: unknown;
                      streams?: unknown;
                  };
                  const streams = Array.isArray(connection.streams)
                      ? connection.streams
                            .map((rawStream): FileShareStreamDiagnostics => {
                                const stream = rawStream as {
                                    id?: unknown;
                                    direction?: unknown;
                                    status?: unknown;
                                    protocol?: unknown;
                                };
                                return {
                                    id: toDiagnosticString(stream.id),
                                    direction: toDiagnosticString(
                                        stream.direction
                                    ),
                                    status: toDiagnosticString(stream.status),
                                    protocol: toDiagnosticString(
                                        stream.protocol
                                    ),
                                };
                            })
                            .sort((left, right) =>
                                compareDiagnosticRecords(left, right, [
                                    "protocol",
                                    "direction",
                                    "id",
                                    "status",
                                ])
                            )
                      : [];
                  return {
                      id: toDiagnosticString(connection.id),
                      remotePeer: toDiagnosticString(connection.remotePeer),
                      direction: toDiagnosticString(connection.direction),
                      status: toDiagnosticString(connection.status),
                      multiplexer: toDiagnosticString(connection.multiplexer),
                      streams,
                  };
              })
              .sort((left, right) =>
                  compareDiagnosticRecords(left, right, [
                      "remotePeer",
                      "direction",
                      "id",
                      "status",
                      "multiplexer",
                  ])
              )
        : [];

    const transportStreams = getTransportPeerStreams(peer)
        .flatMap(
            ({
                service,
                expectedProtocol,
                remotePeerHash,
                peerStreams: rawPeerStreams,
            }) => {
                const peerStreams = rawPeerStreams as {
                    peerId?: unknown;
                    publicKey?: { hashcode?: () => unknown };
                    protocol?: unknown;
                    inboundStreams?: unknown;
                    rawOutboundStreams?: unknown;
                    _debugOutboundStats?: () => unknown;
                };
                const remotePeer = toDiagnosticString(peerStreams.peerId);
                let publicKeyHash: string | null = null;
                try {
                    publicKeyHash = toDiagnosticString(
                        peerStreams.publicKey?.hashcode?.()
                    );
                } catch {
                    // Diagnostic collection must not affect the live transport.
                }
                const peerHashIdentityMatch =
                    remotePeerHash != null &&
                    publicKeyHash != null &&
                    remotePeerHash === publicKeyHash;
                const serviceProtocol = toDiagnosticString(
                    peerStreams.protocol
                );
                const inbound = peerStreams.inboundStreams;
                const rawOutbound = peerStreams.rawOutboundStreams;
                let outbound: unknown = [];
                try {
                    outbound = peerStreams._debugOutboundStats?.() ?? [];
                } catch {
                    // Diagnostic collection must not affect the live transport.
                }
                const records: Array<
                    Omit<
                        FileShareTransportStreamDiagnostics,
                        | "connectionIdentityMatchCount"
                        | "connectionId"
                        | "multiplexer"
                    > & { raw: unknown }
                > = [];
                if (Array.isArray(inbound)) {
                    for (const rawRecord of inbound) {
                        const record = rawRecord as {
                            raw?: {
                                id?: unknown;
                                protocol?: unknown;
                            };
                            bytesReceived?: unknown;
                        };
                        records.push({
                            service,
                            remotePeerHash,
                            peerHashIdentityMatch,
                            serviceProtocol,
                            expectedProtocol,
                            protocol: toDiagnosticString(record.raw?.protocol),
                            protocolIdentityMatch:
                                serviceProtocol === expectedProtocol &&
                                toDiagnosticString(record.raw?.protocol) ===
                                    serviceProtocol,
                            remotePeer,
                            id: toDiagnosticString(record.raw?.id),
                            direction: "inbound",
                            bytes: toDiagnosticNumber(record.bytesReceived),
                            aborted: null,
                            counterStreamIdentityMatch:
                                record.raw != null &&
                                toDiagnosticString(record.raw.id) != null,
                            raw: record.raw,
                        });
                    }
                }
                if (Array.isArray(outbound) && Array.isArray(rawOutbound)) {
                    for (const [index, rawStat] of outbound.entries()) {
                        const stat = rawStat as {
                            id?: unknown;
                            bytes?: unknown;
                            aborted?: unknown;
                        };
                        const raw = rawOutbound[index] as
                            | { id?: unknown; protocol?: unknown }
                            | undefined;
                        const rawId = toDiagnosticString(raw?.id);
                        records.push({
                            service,
                            remotePeerHash,
                            peerHashIdentityMatch,
                            serviceProtocol,
                            expectedProtocol,
                            protocol: toDiagnosticString(raw?.protocol),
                            protocolIdentityMatch:
                                serviceProtocol === expectedProtocol &&
                                toDiagnosticString(raw?.protocol) ===
                                    serviceProtocol,
                            remotePeer,
                            id: rawId,
                            direction: "outbound",
                            bytes: toDiagnosticNumber(stat.bytes),
                            aborted:
                                typeof stat.aborted === "boolean"
                                    ? stat.aborted
                                    : null,
                            counterStreamIdentityMatch:
                                rawOutbound.length === outbound.length &&
                                rawId != null &&
                                rawId === toDiagnosticString(stat.id),
                            raw,
                        });
                    }
                }
                return records;
            }
        )
        .map((stream): FileShareTransportStreamDiagnostics => {
            const connectionMatches = rawConnectionList.flatMap(
                (rawConnection) => {
                    const candidate = rawConnection as {
                        id?: unknown;
                        remotePeer?: unknown;
                        status?: unknown;
                        multiplexer?: unknown;
                        streams?: unknown;
                    };
                    const rawStream = stream.raw as {
                        direction?: unknown;
                        status?: unknown;
                        protocol?: unknown;
                    } | null;
                    return Array.isArray(candidate.streams) &&
                        candidate.streams.includes(stream.raw) &&
                        toDiagnosticString(candidate.status) === "open" &&
                        toDiagnosticString(candidate.remotePeer) ===
                            stream.remotePeer &&
                        toDiagnosticString(rawStream?.direction) ===
                            stream.direction &&
                        toDiagnosticString(rawStream?.status) === "open" &&
                        stream.protocolIdentityMatch &&
                        toDiagnosticString(rawStream?.protocol) ===
                            stream.expectedProtocol
                        ? [
                              {
                                  id: toDiagnosticString(candidate.id),
                                  multiplexer: toDiagnosticString(
                                      candidate.multiplexer
                                  ),
                              },
                          ]
                        : [];
                }
            );
            const uniqueConnection =
                connectionMatches.length === 1 ? connectionMatches[0] : null;
            const { raw: _raw, ...serializableStream } = stream;
            return {
                ...serializableStream,
                connectionIdentityMatchCount: connectionMatches.length,
                connectionId: uniqueConnection?.id ?? null,
                multiplexer: uniqueConnection?.multiplexer ?? null,
            };
        })
        .sort(
            (left, right) =>
                TRANSPORT_SERVICE_PROTOCOLS.findIndex(
                    ({ service }) => service === left.service
                ) -
                    TRANSPORT_SERVICE_PROTOCOLS.findIndex(
                        ({ service }) => service === right.service
                    ) ||
                compareDiagnosticRecords(left, right, [
                    "remotePeerHash",
                    "remotePeer",
                    "direction",
                    "connectionId",
                    "multiplexer",
                    "protocol",
                    "id",
                ])
        );

    const directBlockStreams = transportStreams
        .filter((stream) => stream.service === "blocks")
        .map((stream): FileShareDirectBlockStreamDiagnostics => {
            const {
                service: _service,
                remotePeerHash: _remotePeerHash,
                peerHashIdentityMatch: _peerHashIdentityMatch,
                serviceProtocol: _serviceProtocol,
                protocol: _protocol,
                expectedProtocol: _expectedProtocol,
                protocolIdentityMatch: _protocolIdentityMatch,
                ...directBlockStream
            } = stream;
            return directBlockStream;
        });

    return {
        peerId:
            toDiagnosticString(peerLike?.peerId) ??
            toDiagnosticString(peerLike?.libp2p?.peerId),
        connections,
        transportStreams,
        directBlockStreams,
    };
};
