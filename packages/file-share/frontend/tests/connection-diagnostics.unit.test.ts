import { describe, expect, it } from "vitest";
import { getPeerConnectionDiagnostics } from "../src/connection-diagnostics";

const PROTOCOLS = {
    pubsub: "/peerbit/topic-control-plane/2.0.0",
    blocks: "/peerbit/direct-block/1.0.0",
    fanout: "/peerbit/fanout-tree/0.5.0",
} as const;

const stream = (
    protocol: string,
    direction: "inbound" | "outbound",
    id = "0"
) => ({ id, direction, status: "open", protocol });

const peerStreams = ({
    peerId = "writer-peer",
    peerHash = "writer",
    protocol = PROTOCOLS.pubsub,
    inbound = [],
    outbound = [],
    stats = outbound.map((raw, index) => ({
        id: raw.id,
        bytes: (index + 1) * 100,
        aborted: false,
    })),
}: {
    peerId?: string;
    peerHash?: string;
    protocol?: string;
    inbound?: Array<{ raw: ReturnType<typeof stream>; bytesReceived: number }>;
    outbound?: Array<ReturnType<typeof stream>>;
    stats?: Array<{ id: string; bytes: number; aborted: boolean }>;
}) => ({
    peerId,
    publicKey: { hashcode: () => peerHash },
    protocol,
    inboundStreams: inbound,
    rawOutboundStreams: outbound,
    _debugOutboundStats: () => stats,
});

describe("file-share connection diagnostics", () => {
    it("collects pubsub first and preserves raw identity with reused stream ids across WebRTC and Yamux", () => {
        const webRtcPubsub = stream(PROTOCOLS.pubsub, "outbound");
        const yamuxPubsub = stream(PROTOCOLS.pubsub, "outbound");
        const directBlock = stream(PROTOCOLS.blocks, "inbound", "1");
        const fanout = stream(PROTOCOLS.fanout, "inbound", "2");
        const connections = [
            {
                id: "connection-yamux",
                remotePeer: "writer-peer",
                direction: "outbound",
                status: "open",
                multiplexer: "/peerbit/yamux/1.0.0",
                streams: [yamuxPubsub, directBlock],
            },
            {
                id: "connection-webrtc",
                remotePeer: "writer-peer",
                direction: "inbound",
                status: "open",
                multiplexer: "/webrtc",
                streams: [webRtcPubsub, fanout],
            },
        ];
        const result = getPeerConnectionDiagnostics({
            peerId: "reader-peer",
            libp2p: { getConnections: () => connections },
            services: {
                // Deliberately insert blocks first: diagnostics define pubsub as
                // the primary carrier independently of object key order.
                blocks: {
                    peers: new Map([
                        [
                            "writer",
                            peerStreams({
                                protocol: PROTOCOLS.blocks,
                                inbound: [
                                    { raw: directBlock, bytesReceived: 456 },
                                ],
                            }),
                        ],
                    ]),
                },
                pubsub: {
                    peers: new Map([
                        [
                            "writer",
                            peerStreams({
                                outbound: [webRtcPubsub, yamuxPubsub],
                                stats: [
                                    {
                                        id: "0",
                                        bytes: 321,
                                        aborted: false,
                                    },
                                    {
                                        id: "0",
                                        bytes: 123,
                                        aborted: false,
                                    },
                                ],
                            }),
                        ],
                    ]),
                },
                fanout: {
                    peers: new Map([
                        [
                            "writer",
                            peerStreams({
                                protocol: PROTOCOLS.fanout,
                                inbound: [{ raw: fanout, bytesReceived: 789 }],
                            }),
                        ],
                    ]),
                },
            },
        });

        expect(result.transportStreams).toEqual([
            expect.objectContaining({
                service: "pubsub",
                remotePeerHash: "writer",
                peerHashIdentityMatch: true,
                serviceProtocol: PROTOCOLS.pubsub,
                protocol: PROTOCOLS.pubsub,
                expectedProtocol: PROTOCOLS.pubsub,
                protocolIdentityMatch: true,
                remotePeer: "writer-peer",
                id: "0",
                direction: "outbound",
                bytes: 321,
                counterStreamIdentityMatch: true,
                connectionIdentityMatchCount: 1,
                connectionId: "connection-webrtc",
                multiplexer: "/webrtc",
            }),
            expect.objectContaining({
                service: "pubsub",
                id: "0",
                bytes: 123,
                connectionId: "connection-yamux",
                multiplexer: "/peerbit/yamux/1.0.0",
            }),
            expect.objectContaining({
                service: "blocks",
                protocol: PROTOCOLS.blocks,
                expectedProtocol: PROTOCOLS.blocks,
                direction: "inbound",
                bytes: 456,
                connectionId: "connection-yamux",
            }),
            expect.objectContaining({
                service: "fanout",
                protocol: PROTOCOLS.fanout,
                expectedProtocol: PROTOCOLS.fanout,
                direction: "inbound",
                bytes: 789,
                connectionId: "connection-webrtc",
            }),
        ]);
        expect(result.directBlockStreams).toEqual([
            {
                remotePeer: "writer-peer",
                id: "1",
                direction: "inbound",
                bytes: 456,
                aborted: null,
                counterStreamIdentityMatch: true,
                connectionIdentityMatchCount: 1,
                connectionId: "connection-yamux",
                multiplexer: "/peerbit/yamux/1.0.0",
            },
        ]);
        expect(connections[0].streams).toEqual([yamuxPubsub, directBlock]);
    });

    it("does not guess when one raw pubsub stream appears on multiple connections", () => {
        const raw = stream(PROTOCOLS.pubsub, "inbound");
        const result = getPeerConnectionDiagnostics({
            peerId: "reader-peer",
            libp2p: {
                getConnections: () => [
                    {
                        id: "one",
                        remotePeer: "writer-peer",
                        status: "open",
                        multiplexer: "/webrtc",
                        streams: [raw],
                    },
                    {
                        id: "two",
                        remotePeer: "writer-peer",
                        status: "open",
                        multiplexer: "/peerbit/yamux/1.0.0",
                        streams: [raw],
                    },
                ],
            },
            services: {
                pubsub: {
                    peers: new Map([
                        [
                            "writer",
                            peerStreams({
                                inbound: [{ raw, bytesReceived: 10 }],
                            }),
                        ],
                    ]),
                },
            },
        });

        expect(result.transportStreams).toEqual([
            expect.objectContaining({
                service: "pubsub",
                counterStreamIdentityMatch: true,
                connectionIdentityMatchCount: 2,
                connectionId: null,
                multiplexer: null,
            }),
        ]);
    });

    it("rejects an object-identity match owned by the wrong remote peer", () => {
        const raw = stream(PROTOCOLS.pubsub, "inbound");
        const result = getPeerConnectionDiagnostics({
            peerId: "reader-peer",
            libp2p: {
                getConnections: () => [
                    {
                        id: "wrong-peer-connection",
                        remotePeer: "other-peer",
                        status: "open",
                        multiplexer: "/webrtc",
                        streams: [raw],
                    },
                ],
            },
            services: {
                pubsub: {
                    peers: new Map([
                        [
                            "writer",
                            peerStreams({
                                inbound: [{ raw, bytesReceived: 10 }],
                            }),
                        ],
                    ]),
                },
            },
        });

        expect(result.transportStreams).toEqual([
            expect.objectContaining({
                service: "pubsub",
                protocolIdentityMatch: true,
                counterStreamIdentityMatch: true,
                connectionIdentityMatchCount: 0,
                connectionId: null,
                multiplexer: null,
            }),
        ]);
    });

    it("marks mismatched outbound pubsub counter identity as non-authoritative", () => {
        const raw = stream(PROTOCOLS.pubsub, "outbound", "raw-id");
        const result = getPeerConnectionDiagnostics({
            peerId: "reader-peer",
            libp2p: {
                getConnections: () => [
                    {
                        id: "connection",
                        remotePeer: "writer-peer",
                        status: "open",
                        multiplexer: "/webrtc",
                        streams: [raw],
                    },
                ],
            },
            services: {
                pubsub: {
                    peers: new Map([
                        [
                            "writer",
                            peerStreams({
                                outbound: [raw],
                                stats: [
                                    {
                                        id: "different-id",
                                        bytes: 100,
                                        aborted: false,
                                    },
                                ],
                            }),
                        ],
                    ]),
                },
            },
        });

        expect(result.transportStreams).toEqual([
            expect.objectContaining({
                service: "pubsub",
                id: "raw-id",
                bytes: 100,
                counterStreamIdentityMatch: false,
                connectionIdentityMatchCount: 1,
            }),
        ]);
    });

    it("requires the service protocol and safe integer byte evidence", () => {
        const raw = stream(PROTOCOLS.blocks, "inbound");
        const result = getPeerConnectionDiagnostics({
            peerId: "reader-peer",
            libp2p: {
                getConnections: () => [
                    {
                        id: "connection",
                        remotePeer: "writer-peer",
                        status: "open",
                        multiplexer: "/webrtc",
                        streams: [raw],
                    },
                ],
            },
            services: {
                pubsub: {
                    peers: new Map([
                        [
                            "writer",
                            peerStreams({
                                inbound: [
                                    {
                                        raw,
                                        bytesReceived:
                                            Number.MAX_SAFE_INTEGER + 1,
                                    },
                                ],
                            }),
                        ],
                    ]),
                },
            },
        });

        expect(result.transportStreams).toEqual([
            expect.objectContaining({
                service: "pubsub",
                protocol: PROTOCOLS.blocks,
                expectedProtocol: PROTOCOLS.pubsub,
                protocolIdentityMatch: false,
                bytes: null,
                connectionIdentityMatchCount: 0,
            }),
        ]);
    });

    it("requires the PeerStreams protocol to agree with the raw pubsub stream", () => {
        const raw = stream(PROTOCOLS.pubsub, "inbound");
        const result = getPeerConnectionDiagnostics({
            peerId: "reader-peer",
            libp2p: {
                getConnections: () => [
                    {
                        id: "connection",
                        remotePeer: "writer-peer",
                        status: "open",
                        multiplexer: "/webrtc",
                        streams: [raw],
                    },
                ],
            },
            services: {
                pubsub: {
                    peers: new Map([
                        [
                            "writer",
                            peerStreams({
                                protocol: PROTOCOLS.blocks,
                                inbound: [{ raw, bytesReceived: 10 }],
                            }),
                        ],
                    ]),
                },
            },
        });

        expect(result.transportStreams).toEqual([
            expect.objectContaining({
                service: "pubsub",
                serviceProtocol: PROTOCOLS.blocks,
                protocol: PROTOCOLS.pubsub,
                protocolIdentityMatch: false,
                connectionIdentityMatchCount: 0,
            }),
        ]);
    });

    it("reports a mismatched peer-map hash without losing raw connection identity", () => {
        const raw = stream(PROTOCOLS.pubsub, "inbound");
        const result = getPeerConnectionDiagnostics({
            peerId: "reader-peer",
            libp2p: {
                getConnections: () => [
                    {
                        id: "connection",
                        remotePeer: "writer-peer",
                        status: "open",
                        multiplexer: "/webrtc",
                        streams: [raw],
                    },
                ],
            },
            services: {
                pubsub: {
                    peers: new Map([
                        [
                            "wrong-hash",
                            peerStreams({
                                peerHash: "writer",
                                inbound: [{ raw, bytesReceived: 10 }],
                            }),
                        ],
                    ]),
                },
            },
        });

        expect(result.transportStreams).toEqual([
            expect.objectContaining({
                service: "pubsub",
                remotePeerHash: "wrong-hash",
                peerHashIdentityMatch: false,
                connectionIdentityMatchCount: 1,
                connectionId: "connection",
            }),
        ]);
    });

    it("rejects outbound evidence when raw streams and counter stats have different lengths", () => {
        const first = stream(PROTOCOLS.pubsub, "outbound", "first");
        const second = stream(PROTOCOLS.pubsub, "outbound", "second");
        const result = getPeerConnectionDiagnostics({
            peerId: "reader-peer",
            libp2p: {
                getConnections: () => [
                    {
                        id: "connection",
                        remotePeer: "writer-peer",
                        status: "open",
                        multiplexer: "/webrtc",
                        streams: [first, second],
                    },
                ],
            },
            services: {
                pubsub: {
                    peers: new Map([
                        [
                            "writer",
                            peerStreams({
                                outbound: [first, second],
                                stats: [
                                    {
                                        id: "first",
                                        bytes: 10,
                                        aborted: false,
                                    },
                                ],
                            }),
                        ],
                    ]),
                },
            },
        });

        expect(result.transportStreams).toEqual([
            expect.objectContaining({
                service: "pubsub",
                id: "first",
                counterStreamIdentityMatch: false,
            }),
        ]);
    });

    it("uses nulls and empty arrays when peers or services are unavailable", () => {
        expect(getPeerConnectionDiagnostics(undefined)).toEqual({
            peerId: null,
            connections: [],
            transportStreams: [],
            directBlockStreams: [],
        });
        expect(
            getPeerConnectionDiagnostics({
                libp2p: {
                    peerId: { toString: () => "fallback-peer" },
                    getConnections: () => [
                        {
                            id: "connection",
                            remotePeer: null,
                            streams: null,
                        },
                    ],
                },
                services: {
                    pubsub: {},
                    blocks: {
                        peers: {
                            values: () => {
                                throw new Error();
                            },
                        },
                    },
                },
            })
        ).toEqual({
            peerId: "fallback-peer",
            connections: [
                {
                    id: "connection",
                    remotePeer: null,
                    direction: null,
                    status: null,
                    multiplexer: null,
                    streams: [],
                },
            ],
            transportStreams: [],
            directBlockStreams: [],
        });
    });
});
