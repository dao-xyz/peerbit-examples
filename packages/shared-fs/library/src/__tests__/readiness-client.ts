// Test-only readiness client: drives OPEN, CELLS_REQ, LIST and CLOSE
// against a responder, either over a real RPC on the filesystem's readiness
// topic or in memory (the responder's send port delivers to the client).
// Not built into lib/ (tsconfig excludes src/__tests__); the cross-process
// harness carries its own copy.
import { randomBytes, type PublicSignKey } from "@peerbit/crypto";
import { RPC } from "@peerbit/rpc";
import type { ProgramClient } from "@peerbit/program";
import { DIGEST_BYTES } from "../readiness/constants.js";
import type { Responder, ResponderPorts } from "../readiness/responder.js";
import {
    CellsReqV1,
    CloseV1,
    ListPageV1,
    ListV1,
    OpenScopeV1,
    OpenV1,
    ReadinessMessage,
} from "../readiness/wire.js";

type Waiter = {
    match(message: ReadinessMessage): boolean;
    resolve(message: ReadinessMessage): void;
};

export class ReadinessClient {
    readonly inbox: ReadinessMessage[] = [];
    private readonly waiters = new Set<Waiter>();

    constructor(
        private readonly transport: (message: ReadinessMessage) => Promise<void>
    ) {}

    /**
     * A client on its own RPC program, subscribed to the responder's
     * readiness topic, sending to `responder`.
     */
    static async overRpc(
        peer: ProgramClient,
        topic: string,
        responder: PublicSignKey
    ): Promise<{
        client: ReadinessClient;
        rpc: RPC<ReadinessMessage, ReadinessMessage>;
    }> {
        let client!: ReadinessClient;
        const rpc = await peer.open(
            new RPC<ReadinessMessage, ReadinessMessage>(),
            {
                args: {
                    topic,
                    queryType: ReadinessMessage,
                    responseType: ReadinessMessage,
                    responseHandler: (message) => {
                        client.receive(message);
                        return undefined;
                    },
                },
            }
        );
        client = new ReadinessClient((message) =>
            rpc.send(message, { to: [responder] })
        );
        await rpc.waitFor(responder);
        return { client, rpc };
    }

    receive(message: ReadinessMessage) {
        this.inbox.push(message);
        for (const waiter of [...this.waiters]) {
            if (waiter.match(message)) {
                this.waiters.delete(waiter);
                waiter.resolve(message);
            }
        }
    }

    send(message: ReadinessMessage) {
        return this.transport(message);
    }

    /** The first inbox message (already received or later) that matches. */
    next<T extends ReadinessMessage>(
        type: abstract new (...args: any[]) => T,
        predicate: (message: T) => boolean = () => true,
        options: { timeoutMs?: number; after?: number } = {}
    ): Promise<T> {
        const match = (message: ReadinessMessage) =>
            message instanceof type && predicate(message as T);
        const found = this.inbox
            .slice(options.after ?? 0)
            .find((message) => match(message));
        if (found) return Promise.resolve(found as T);
        return new Promise<T>((resolve, reject) => {
            const waiter: Waiter = {
                match,
                resolve: (message) => {
                    clearTimeout(timer);
                    resolve(message as T);
                },
            };
            const timer = setTimeout(() => {
                this.waiters.delete(waiter);
                reject(
                    new Error(
                        `no ${type.name} within ${options.timeoutMs ?? 30_000} ms; inbox: ${this.inbox
                            .map((message) => message.constructor.name)
                            .join(", ")}`
                    )
                );
            }, options.timeoutMs ?? 30_000);
            this.waiters.add(waiter);
        });
    }

    open(properties: {
        sessionId?: Uint8Array;
        attempt?: number;
        flags?: number;
        hlcProved?: bigint;
        version?: number;
        scopes: Array<{
            scope: number;
            logId: Uint8Array;
            count: number;
            above?: number;
        }>;
    }) {
        const sessionId = properties.sessionId ?? randomBytes(16);
        const message = new OpenV1({
            version: properties.version,
            sessionId,
            attempt: properties.attempt ?? 1,
            flags: properties.flags,
            hlcProved: properties.hlcProved ?? 0n,
            scopes: properties.scopes.map(
                (scope) =>
                    new OpenScopeV1({
                        scope: scope.scope,
                        logId: scope.logId,
                        count: scope.count,
                        above: scope.above ?? 0,
                    })
            ),
        });
        return { sessionId, sent: this.send(message) };
    }

    cellsReq(
        sessionId: Uint8Array,
        scope: number,
        logId: Uint8Array,
        from: number,
        to: number
    ) {
        return this.send(new CellsReqV1({ sessionId, scope, logId, from, to }));
    }

    listPage(
        sessionId: Uint8Array,
        scope: number,
        logId: Uint8Array,
        offset: number
    ) {
        return this.send(new ListPageV1({ sessionId, scope, logId, offset }));
    }

    close(sessionId: Uint8Array) {
        return this.send(new CloseV1({ sessionId }));
    }

    /** Pages a list-mode session until `done`; the hashes in order. */
    async collectList(
        sessionId: Uint8Array,
        scope: number,
        logId: Uint8Array
    ): Promise<Uint8Array> {
        const pages: Uint8Array[] = [];
        let offset = 0;
        for (;;) {
            const after = this.inbox.length;
            await this.listPage(sessionId, scope, logId, offset);
            const page = await this.next(
                ListV1,
                (message) =>
                    sameBytes(message.sessionId, sessionId) &&
                    message.scope === scope &&
                    message.offset === offset,
                { after }
            );
            pages.push(page.hashes);
            offset += page.hashes.length / DIGEST_BYTES;
            if (page.done) break;
        }
        const out = new Uint8Array(offset * DIGEST_BYTES);
        let o = 0;
        for (const page of pages) {
            out.set(page, o);
            o += page.length;
        }
        return out;
    }
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * In-memory transport: the responder's send port delivers to the client of
 * the addressed peer; a client's send goes straight to the responder.
 */
export class DirectNetwork {
    private readonly clients = new Map<string, ReadinessClient>();
    responder?: Responder;
    readonly sent: Array<{ to: string; message: ReadinessMessage }> = [];

    /** The send port for a responder under test. */
    readonly send: ResponderPorts["send"] = async (message, to) => {
        const hash = to.hashcode();
        this.sent.push({ to: hash, message });
        this.clients.get(hash)?.receive(message);
    };

    client(from: PublicSignKey): ReadinessClient {
        const client = new ReadinessClient(async (message) => {
            this.responder!.onMessage(message, from);
        });
        this.clients.set(from.hashcode(), client);
        return client;
    }
}
