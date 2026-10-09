// Child process for readiness-departure.node.test.ts, run with
// `node --import tsx` like process-crash-durability.worker.ts; the anchor
// worker's `__name` shim (S13) keeps its serialized source working under
// tsx, and `opened` reports the host mode. This process is the peer R that
// departs: it opens the filesystem as a full replica whose responder drops
// every OPEN (R never answers), and the parent kills it with SIGKILL or
// freezes it with SIGSTOP. It never closes cleanly.
import { Peerbit } from "peerbit";
import { openSharedFs } from "../index.js";
import { OpenV1, type ReadinessMessage } from "../readiness/wire.js";
import type {
    DepartureCommand,
    DepartureReport,
} from "./readiness-departure.protocol.js";

// The parent is the only lifecycle owner: losing the IPC channel must never
// orphan a live peer.
process.once("disconnect", () => process.exit(2));

const send = (report: DepartureReport) =>
    new Promise<void>((resolve, reject) => {
        if (!process.send) {
            reject(new Error("departure worker requires a Node IPC channel"));
            return;
        }
        process.send(report, (error: Error | null) =>
            error ? reject(error) : resolve()
        );
    });

// Denied before any dial (the relayed topology keeps R and J apart, also
// through a circuit relay).
const deny = new Set<string>();
const denied = (peerId: unknown) => deny.has(String(peerId));

const connect = async (
    peer: Peerbit,
    command: Extract<DepartureCommand, { type: "connect" }>
) => {
    for (const peerId of command.deny) deny.add(peerId);
    (peer.services.pubsub as any).setTopicRootCandidates(command.candidates);
    for (const address of command.dial) await peer.dial(address);
    await send({ type: "connected" });
};

const open = async (
    peer: Peerbit,
    command: Extract<DepartureCommand, { type: "open" }>
) => {
    const fs = await openSharedFs({
        peerbit: peer,
        address: command.address,
        machineLabel: "departure-r",
        bootstrap: false,
        gc: false,
        // R runs no join of its own, so the only readiness traffic between
        // R and the joiner is the joiner's OPENs, which R drops.
        allowPartialWrites: true,
    });
    const runtime = (fs.program as any).readinessRuntime;
    const responder = runtime.responder;
    const onMessage = responder.onMessage;
    responder.onMessage = (message: ReadinessMessage, from: any) => {
        if (message instanceof OpenV1) {
            void send({ type: "dropped", from: from?.hashcode?.() }).catch(
                () => undefined
            );
            return;
        }
        return onMessage.call(responder, message, from);
    };
    await runtime.whenStarted();
    await send({
        type: "opened",
        topic: (fs.program as any).readiness.topic,
        anchorMode: runtime.anchorHost?.mode ?? "none",
    });
};

const main = async () => {
    const peer = await Peerbit.create({
        libp2p: {
            connectionGater: {
                denyDialPeer: async (peerId: unknown) => denied(peerId),
                denyInboundEncryptedConnection: async (peerId: unknown) =>
                    denied(peerId),
                denyOutboundEncryptedConnection: async (peerId: unknown) =>
                    denied(peerId),
                denyInboundRelayedConnection: async (
                    _relay: unknown,
                    remote: unknown
                ) => denied(remote),
                denyOutboundRelayedConnection: async (
                    _relay: unknown,
                    remote: unknown
                ) => denied(remote),
            },
        },
    } as any);
    process.on("message", (raw: unknown) => {
        const command = raw as DepartureCommand;
        if (command?.type === "connect") connect(peer, command).catch(fail);
        else if (command?.type === "open") open(peer, command).catch(fail);
    });
    await send({
        type: "hello",
        hash: peer.identity.publicKey.hashcode(),
        peerId: peer.peerId.toString(),
        addrs: peer
            .getMultiaddrs()
            .map((address) => address.toString())
            .filter(
                (address) =>
                    address.startsWith("/ip4/127.0.0.1/tcp/") &&
                    !address.includes("/ws") &&
                    !address.includes("p2p-circuit")
            ),
        pid: process.pid,
    });
    // Parked until the parent kills or freezes this process; the timer
    // only keeps the event loop alive.
    setInterval(() => undefined, 60_000);
};

const fail = async (error: unknown) => {
    const normalized =
        error instanceof Error ? error : new Error(String(error));
    try {
        await send({
            type: "fatal",
            message: normalized.message,
            stack: normalized.stack,
        });
    } finally {
        process.exit(1);
    }
};

main().catch(fail);
