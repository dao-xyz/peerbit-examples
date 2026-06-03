import { field, variant } from "@dao-xyz/borsh";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webSockets } from "@libp2p/websockets";
import { sha256Sync } from "@peerbit/crypto";
import { Documents } from "@peerbit/document";
import { Program } from "@peerbit/program";
import { Peerbit } from "peerbit";
import { v4 as uuid } from "uuid";

const borshField = field as unknown as (
    properties: Parameters<typeof field>[0]
) => PropertyDecorator;
const borshVariant = variant as unknown as (
    index: Parameters<typeof variant>[0]
) => ClassDecorator;

const relayTransport = circuitRelayTransport({}) as unknown as ReturnType<
    typeof webSockets
>;

export class SimpleDocument {
    @borshField({ type: "string" })
    id: string;

    @borshField({ type: "string" })
    content: string;

    constructor(properties: { content: string }) {
        this.id = uuid();
        this.content = properties.content;
    }
}

@borshVariant("vue-example-store")
export class ExampleStore extends Program {
    @borshField({ type: Documents })
    documents: Documents<SimpleDocument>;

    constructor() {
        super();
        this.documents = new Documents({
            id: sha256Sync(new TextEncoder().encode("vue-example-store")),
        });
    }

    async open(): Promise<void> {
        await this.documents.open({
            type: SimpleDocument,
        });
    }
}

export const createClient = async (localNetwork = false) => {
    const client = await Peerbit.create({
        libp2p: {
            addresses: {
                listen: [],
            },
            connectionGater: localNetwork
                ? {
                      denyDialMultiaddr: () => false,
                  }
                : undefined,
            transports: [webSockets({}), relayTransport],
        },
    });

    if (localNetwork) {
        await client.dial(
            "/ip4/127.0.0.1/tcp/8002/ws/p2p/" +
                (await (await fetch("http://localhost:8082/peer/id")).text())
        );
    } else {
        await client.bootstrap();
    }

    return client;
};
