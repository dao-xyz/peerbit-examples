// Child process for readiness-departure.node.test.ts, run with
// `node --import tsx` like process-crash-durability.worker.ts; the anchor
// worker's `__name` shim (S13) keeps its serialized source working under
// tsx, and `opened` reports the host mode. This process is the peer R that
// departs: it opens the filesystem as a full replica whose responder drops
// every OPEN (R never answers), and the parent kills it with SIGKILL or
// freezes it with SIGSTOP. It never closes cleanly. In test 38 (`open-acl`)
// R is instead the owner of an access-controlled store that answers.
import { Peerbit } from "peerbit";
import { openSharedFs } from "../index.js";
import {
    NAMESPACE_V1,
    TRUST_V1,
    type ScopeDescriptor,
} from "../readiness/scopes.js";
import { documentsIndexPort } from "../readiness/tap.js";
import { OpenV1, type ReadinessMessage } from "../readiness/wire.js";
import type {
    DepartureCommand,
    DepartureReport,
    DepartureRow,
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

/** Resolves once `check` holds (setup only; the parent bounds the test). */
const until = async (
    check: () => Promise<boolean>,
    what: string,
    timeoutMs = 60_000
) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check().catch(() => false))) {
        if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

/** A scope's index rows, read through the tap's own index port. */
const rowsOf = async (documents: any, scope: ScopeDescriptor) => {
    const rows: DepartureRow[] = [];
    for await (const page of documentsIndexPort(documents, scope).scan()) {
        for (const { key, head } of page) {
            rows.push({
                key:
                    typeof key === "string"
                        ? key
                        : Buffer.from(key).toString("hex"),
                head,
            });
        }
    }
    return rows;
};

const decode = (bytes: Uint8Array | undefined) =>
    bytes ? new TextDecoder().decode(bytes) : undefined;

const openAcl = async (
    peer: Peerbit,
    command: Extract<DepartureCommand, { type: "open-acl" }>
) => {
    (peer.services.pubsub as any).setTopicRootCandidates(command.candidates);
    const fs = await openSharedFs({
        peerbit: peer,
        rootKey: peer.identity.publicKey,
        machineLabel: "departure-r",
        gc: false,
    });
    await fs.writeFile("/owner.txt", "from the owner");
    // W, the writer R grants: its rows are admitted only by a peer holding
    // R's edge. It stops before R reports.
    const writerPeer = await Peerbit.create();
    try {
        (writerPeer.services.pubsub as any).setTopicRootCandidates(
            command.candidates
        );
        await writerPeer.dial(peer);
        const writerFs = await openSharedFs({
            peerbit: writerPeer,
            address: fs.address!,
            machineLabel: "departure-w",
            bootstrap: false,
            gc: false,
            // W writes once it holds R's edge; it never joins for readiness.
            allowPartialWrites: true,
        });
        await fs.authorizeWriter(writerPeer.identity.publicKey);
        await until(
            () => writerFs.isTrustedWriter(writerPeer.identity.publicKey),
            "W holds R's edge"
        );
        await until(async () => {
            await writerFs.writeFile("/writer.txt", "from the writer");
            return true;
        }, "W's write");
        await until(
            async () =>
                decode(await fs.readFile("/writer.txt")) === "from the writer",
            "R holds W's file"
        );
    } finally {
        await writerPeer.stop();
    }
    const program = fs.program as any;
    const runtime = program.readinessRuntime;
    await runtime.whenStarted();
    const trustDocuments = program.trustGraph.trustGraph;
    const namespace: Array<DepartureRow & { signer: string }> = [];
    for (const row of await rowsOf(program.entries, NAMESPACE_V1)) {
        const entry = await program.entries.log.log.get(row.head);
        const keys = entry ? await entry.getPublicKeys() : [];
        namespace.push({
            ...row,
            signer: keys.map((key: any) => key.hashcode()).join(","),
        });
    }
    await send({
        type: "acl-opened",
        address: fs.address!,
        trustLogId: Buffer.from(trustDocuments.log.log.id).toString("hex"),
        writer: writerPeer.identity.publicKey.hashcode(),
        trust: await rowsOf(trustDocuments, TRUST_V1),
        namespace,
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
        else if (command?.type === "open-acl") {
            openAcl(peer, command).catch(fail);
        }
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
