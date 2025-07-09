import { usePeer } from "@peerbit/react";
import { useIdentities } from "./useIdentities";
import { Connection } from "@giga-app/interface";
import { CiCircleRemove } from "react-icons/ci";
import { JSX } from "react";

export const ListDevices = () => {
    const { identities, devices } = useIdentities();
    const { peer } = usePeer();

    const renderConnection = (
        connection: Connection,
        index: number
    ): JSX.Element => {
        const otherDevice = connection.getOtherDevice(peer.identity.publicKey);
        return (
            <li key={index} className="p-4 flex flex-row">
                <div>
                    <span className="block text-lg font-semibold">Device</span>
                    {otherDevice ? (
                        <span className="text-gray-800">
                            {otherDevice.name}
                        </span>
                    ) : (
                        <span className="italic">INVALID DEVICE LINK</span>
                    )}
                </div>
                <button
                    className="ml-auto btn btn-icon btn-elevated"
                    onClick={() => identities.connections.del(connection.id)}
                >
                    <CiCircleRemove size={25} />
                </button>
            </li>
        );
    };

    return (
        <div className="p-4 space-y-6">
            <h2>Linked devices</h2>
            {!devices || devices.length === 0 ? (
                <p className="text-gray-500">No trusted devices found.</p>
            ) : (
                <ul className="space-y-4">
                    {devices.map((relation, index) =>
                        renderConnection(relation, index)
                    )}
                </ul>
            )}
        </div>
    );
};
