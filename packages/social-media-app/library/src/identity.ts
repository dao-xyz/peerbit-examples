import { field, fixedArray, option, serialize, variant } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import {
    PublicSignKey,
    sha256Sync,
    toBase64URL,
    fromBase64URL,
    randomBytes,
} from "@peerbit/crypto";
import {
    And,
    BoolQuery,
    ByteMatchQuery,
    Documents,
    Or,
} from "@peerbit/document";
import { concat } from "uint8arrays";
import { deserialize } from "@dao-xyz/borsh";
import QRCode from "qrcode"; // Ensure you have installed the "qrcode" package
import pDefer from "p-defer";

// Helper to compare two Uint8Arrays.
function uint8ArrayEquals(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/* ───── DEVICE CLASSES ───────────────────────────── */

@variant(0)
export class Device {
    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: "string" })
    name: string;

    constructor(publicKey: PublicSignKey, name?: string) {
        // When not provided, we use a “dummy” public key (depending on your app you may want to handle absence differently)
        this.publicKey = publicKey;
        this.name = name || "";
    }
}

@variant(0)
export class DeviceIndexed {
    @field({ type: Uint8Array })
    publicKey: Uint8Array;

    @field({ type: "string" })
    name: string;

    constructor(device: { publicKey: PublicSignKey; name: string }) {
        this.publicKey = device.publicKey.bytes;
        this.name = device.name;
    }
}

/* ───── CONNECTION CLASSES ───────────────────────── */

@variant(0)
export class Connection {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: Device })
    device1: Device;

    // device2 is optional until the responder updates the document.
    @field({ type: option(Device) })
    device2?: Device;

    @field({ type: fixedArray("u8", 32) })
    nonce: Uint8Array;

    @field({ type: "bool" })
    verified: boolean;
    // When first “put” the connection is unverified (false).
    // When the responder later “puts” the document (with the same id) its device info is added and verified is set to true.

    // For the initiator, we only know our own device info (device1)
    constructor(properties: {
        device1: Device;
        device2?: Device;
        verified?: boolean;
        nonce: Uint8Array;
    }) {
        this.device1 = properties.device1;
        this.device2 = properties.device2;

        this.nonce = properties.nonce;
        this.verified = properties.verified || false;
        // Compute a unique id based on the initiator’s public key and the nonce.
        this.id = randomBytes(32);
    }

    // Called by the responder to update this connection with its device info.
    updateWithDevice2(device2: Device) {
        if (this.device1.publicKey.equals(device2.publicKey)) {
            throw new Error("Device 1 and Device 2 are the same");
        }
        this.device2 = device2;
        this.verified = true;
    }
    getOtherDevice(me: PublicSignKey) {
        if (this.device1.publicKey.equals(me)) {
            return this.device2;
        } else {
            return this.device1;
        }
    }
}

@variant(0)
export class ConnectionIndexed {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: DeviceIndexed })
    device1: DeviceIndexed;

    @field({ type: option(DeviceIndexed) })
    device2?: DeviceIndexed;

    @field({ type: fixedArray("u8", 32) })
    nonce: Uint8Array;

    @field({ type: "bool" })
    verified: boolean;

    constructor(connection: {
        id: Uint8Array;
        device1: DeviceIndexed;
        device2?: DeviceIndexed;
        nonce: Uint8Array;
        verified: boolean;
    }) {
        this.id = connection.id;
        this.device1 = connection.device1;
        this.device2 = connection.device2;
        this.nonce = connection.nonce;
        this.verified = connection.verified;
    }
}
type BroadcastConnectionRequest = {
    type: "connection-start";
    connection: Uint8Array;
};

type BroadcastTabIsAvailable = {
    type: "tab-available";
    tabId: number;
};

/* ───── IDENTITIES (SINGLE DB) ───────────────────── */
type IdentitiesArgs = {
    deviceName: string;
    connectTabs?: {
        id: number;
    };
    replicate?: boolean;
};

@variant("identity")
export class Identities extends Program<IdentitiesArgs> {
    // The single DB for connection objects.
    @field({ type: Documents })
    connections: Documents<Connection, ConnectionIndexed>;

    // Base URL (including deep-link prefix, e.g. "http://localhost:5173/#/connect?data=").
    public baseUrl: string;
    private device: Device;

    // Broadcast channel for syncing identities across tabs.
    broadcastChannel?: BroadcastChannel;

    constructor(properties: { id?: Uint8Array; baseUrl: string }) {
        super();
        this.baseUrl = properties.baseUrl;
        const id =
            properties.id || sha256Sync(new TextEncoder().encode("identities"));
        // Initialize the connections database (using a unique id for connections)
        this.connections = new Documents({
            id: sha256Sync(
                concat([id, new TextEncoder().encode("connections")])
            ),
        });
    }

    set deviceName(name: string) {
        this.device = new Device(this.node.identity.publicKey, name);
    }
    async open(args?: IdentitiesArgs): Promise<void> {
        if (!this.device) {
            this.deviceName = args?.deviceName ?? "Device McDeviceface";
        }

        await this.connections.open({
            replicate:
                args?.replicate != null
                    ? args?.replicate
                        ? { factor: 1 }
                        : false
                    : { factor: 1 }, // TODO choose better
            type: Connection,
            index: {
                prefetch: {
                    strict: false,
                },
                cache: {
                    query: {
                        strategy: "auto",
                        maxSize: 50,
                        maxTotalSize: 1e4,
                        keepAlive: 1e4,
                        prefetchThreshold: 3,
                    },
                },
                transform: async (arg, context) => {
                    return new ConnectionIndexed({
                        id: arg.id,
                        device1: new DeviceIndexed({
                            publicKey: arg.device1.publicKey,
                            name: arg.device1.name,
                        }),
                        device2: arg.device2
                            ? new DeviceIndexed({
                                publicKey: arg.device2.publicKey,
                                name: arg.device2.name,
                            })
                            : undefined,
                        nonce: arg.nonce,
                        verified: arg.verified,
                    });
                },
                type: ConnectionIndexed,
            },
            canPerform: () => true, // TODO make sure first signer assigned device 1 and second signer device 2
        });

        // Initialize the broadcast channel and set up the listener.
        if (args?.connectTabs) {
            this.setupBroadcastChannel();

            if (args?.connectTabs.id === 0) {
                this.broadcastChannel!.postMessage({
                    type: "connection-start",
                    connection: serialize(
                        new Connection({
                            device1: this.device,
                            nonce: randomBytes(32),
                        })
                    ),
                } as BroadcastConnectionRequest);
            } else if (args?.connectTabs.id) {
                this.broadcastChannel!.postMessage({
                    type: "tab-available",
                    tabId: args?.connectTabs.id,
                } as BroadcastTabIsAvailable);
            }
        }
    }
    async close(from?: Program): Promise<boolean> {
        const closed = await super.close(from);
        if (closed) {
            this.broadcastChannel?.close();
        }
        return closed;
    }

    setupBroadcastChannel() {
        this.broadcastChannel = new BroadcastChannel("identities-sync");
        this.broadcastChannel.onmessage = async (event) => {
            const message = event.data as
                | BroadcastConnectionRequest
                | BroadcastTabIsAvailable;

            if (message.type === "connection-start") {
                const serializedConnection = event.data.connection;
                // Deserialize the connection.
                const connection = deserialize(
                    serializedConnection,
                    Connection
                );

                // Update the local document store.
                await this.approveAndDeduplicateConnection(connection); // approve connecitons updates that are sent to me through other tabs
            }
            if (message.type === "tab-available") {
                this.broadcastChannel!.postMessage({
                    type: "connection-start",
                    connection: serialize(
                        new Connection({
                            device1: this.device,
                            nonce: randomBytes(32),
                        })
                    ),
                } as BroadcastConnectionRequest);
            }
        };
    }

    async broadcastConnectionUpdate(connection: Connection) {
        if (!this.broadcastChannel) {
            return;
        }

        const serialized = serialize(connection);
        this.broadcastChannel.postMessage({
            type: "connection-start",
            connection: serialized,
        });
        console.log("Broadcasted connection update");
    }

    async getAllLinkedDevices(
        publicKey: PublicSignKey = this.node.identity.publicKey
    ) {
        return await this.connections.index.search({
            query: this.getLinkedDevicesQuery(publicKey),
        });
    }

    async isConnected(publicKey: PublicSignKey) {
        const linked = await this.getAllLinkedDevices(publicKey);
        return linked.length > 0;
    }

    getLinkedDevicesQuery(
        publicKey: PublicSignKey = this.node.identity.publicKey
    ): And {
        return new And([
            new Or([
                new ByteMatchQuery({
                    key: ["device1", "publicKey"],
                    value: publicKey.bytes,
                }),
                new ByteMatchQuery({
                    key: ["device2", "publicKey"],
                    value: publicKey.bytes,
                }),
            ]),
            new BoolQuery({
                key: "verified",
                value: true,
            }),
        ]);
    }

    // Generate a QR code image from the provided data.
    async generateQRCodeDataURL(properties: {
        canvas?: HTMLCanvasElement;
        data: Uint8Array;
    }): Promise<string> {
        if (properties.canvas === undefined) {
            return await QRCode.toDataURL([
                { mode: "byte", data: properties.data },
            ]);
        } else {
            return await QRCode.toDataURL(properties.canvas, [
                { mode: "byte", data: properties.data },
            ]);
        }
    }

    // Returns the encoded connection document as a URL-safe Base64 string.
    getEncodedConnection(serializedData: Uint8Array): string {
        return toBase64URL(serializedData);
    }

    private async approveAndDeduplicateConnection(connection: Connection) {
        if (await this.isConnected(connection.device1.publicKey)) {
            // "Already connected";
            return;
        }
        // Update the connection document with the responder’s info.
        connection.updateWithDevice2(this.device);
        await this.connections.put(connection);
    }
    /**
     * Initiates the connection flow.
     *
     * There are two modes:
     *  1. Initiator mode (no encodedConnection provided): This creates a new Connection document
     *     with the initiator’s device info (device1) and a random nonce. It then generates a deep link
     *     URL (and corresponding QR code) for the responder.
     *
     *  2. Responder mode (encodedConnection provided): The responder receives the encoded connection
     *     via a deep link URL, decodes it, updates it with its own device info (device2), sets verified to true,
     *     and “puts” the updated document.
     *
     * @param properties.canvas Optional canvas element for QR generation.
     * @param properties.onCode Callback receiving an object with the encoded connection, deep link URL, and QR code URL.
     * @param properties.deviceName The device name for the current device (default is "Device McDeviceface").
     * @param properties.encodedConnection Optional encoded connection (present when acting as the responder).
     * @returns The public key of the remote (other) device.
     */
    async connectDevicesFlow(
        properties:
            | {
                canvas?: HTMLCanvasElement;
                onCode?: (result: {
                    encodedConnection: string;
                    deepLinkUrl: string;
                    qrCodeUrl: string;
                }) => void;
            }
            | {
                deepLinkOrCode: string;
            }
    ): Promise<Connection> {
        if (!this.baseUrl) {
            throw new Error("Baseurl not set!");
        }
        if ("deepLinkOrCode" in properties) {
            // Responder flow:
            // Decode the connection from the deep link.
            let split = properties.deepLinkOrCode.split(this.baseUrl);
            const data = split.length > 1 ? split[1] : split[0];
            const connectionBytes = fromBase64URL(data);
            const connection = deserialize(connectionBytes, Connection);
            // Update the connection document with the responder’s info.
            await this.approveAndDeduplicateConnection(connection);

            // Return the initiator’s public key.
            return connection;
        } else {
            // Initiator flow:
            const nonce = crypto.getRandomValues(new Uint8Array(32));
            const connection = new Connection({ device1: this.device, nonce });
            const serializedData = serialize(connection);
            const encodedConnection = this.getEncodedConnection(serializedData);
            const deepLinkUrl = this.baseUrl + encodedConnection;
            const qrCodeUrl = await this.generateQRCodeDataURL({
                canvas: properties.canvas,
                data: new TextEncoder().encode(deepLinkUrl),
            });
            if (properties.onCode) {
                properties.onCode({
                    encodedConnection,
                    deepLinkUrl,
                    qrCodeUrl,
                });
            }
            // Put the new connection document into the DB.
            await this.connections.put(connection);
            /* this.broadcastChannel.postMessage({
                type: "connection-start",
                connection: serializedData,
            }); */

            // Wait for the responder to update the document (i.e. verified becomes true).
            let deferred = pDefer<Connection>();
            const listener = (evt: { detail: { added: Connection[] } }) => {
                for (const conn of evt.detail.added) {
                    if (uint8ArrayEquals(conn.nonce, nonce) && conn.verified) {
                        // Return the responder’s public key from device2.
                        this.connections.events.removeEventListener(
                            "change",
                            listener
                        );
                        deferred.resolve(conn);
                        return;
                    }
                }
            };

            // we need to also search because we might already have synced results, and change events won't propagate if we add event listener to late
            const immediateResults = await this.connections.index.search(
                {
                    query: {
                        nonce: nonce,
                        verified: true,
                    },
                },
                {
                    remote: false /* {
                        eager: true
                    }, */,
                    local: true,
                }
            );
            if (immediateResults.length > 0) {
                listener({
                    detail: {
                        added: immediateResults,
                    },
                });
            }

            this.connections.events.addEventListener("change", listener);
            setTimeout(() => {
                this.connections.events.removeEventListener("change", listener);
                deferred.reject(
                    new Error("Timeout waiting for connection verification.")
                );
            }, 1e4);
            return deferred.promise;
        }
    }
}
