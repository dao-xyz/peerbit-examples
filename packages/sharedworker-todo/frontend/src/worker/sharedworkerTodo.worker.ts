/// <reference lib="webworker" />

import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webSockets } from "@libp2p/websockets";
import { installSharedWorkerHost } from "@peerbit/canonical-host/shared-worker";
import {
    documentModule,
    registerDocumentType,
} from "@peerbit/document-proxy/host";
import { TodoItem } from "../todo/model";

const relayTransport = circuitRelayTransport({}) as unknown as ReturnType<
    typeof webSockets
>;

// Make the document type available to @peerbit/document-proxy.
registerDocumentType(TodoItem);

// Install a canonical Peerbit host inside the SharedWorker and expose the documents module.
installSharedWorkerHost({
    modules: [documentModule],
    peerOptions: {
        libp2p: {
            addresses: {
                // A SharedWorker is the single canonical host for all tabs; no inbound listening needed.
                listen: [],
            },
            transports: [webSockets({}), relayTransport],
        },
    },
});
