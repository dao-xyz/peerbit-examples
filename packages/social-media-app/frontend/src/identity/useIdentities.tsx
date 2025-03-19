import { useLocal, usePeer, useProgram } from "@peerbit/react";
import React, { useContext } from "react";
import { Connection, Identities, Profiles } from "@dao-xyz/social";
import { And, BoolQuery, ByteMatchQuery, Or } from "@peerbit/indexer-interface";
import { CiCircleRemove } from "react-icons/ci";
import { PublicSignKey } from "@peerbit/crypto";

interface IIdentitiesContext {
    identities?: Identities;
    devices?: Connection[];
    isMe: (identityKey: PublicSignKey | Uint8Array) => boolean;
}

export const IdentitiesContext = React.createContext<IIdentitiesContext>(
    {} as any
);
export const useIdentities = () => useContext(IdentitiesContext);

export const IdentitiesProvider = ({ children }: { children: JSX.Element }) => {
    // Determine the base URL based on the environment.
    const baseUrl =
        import.meta.env.MODE === "development"
            ? "http://localhost:5173/#/connect?data="
            : "https://giga.place/#/connect?data=";

    const identities = useProgram(new Identities({ baseUrl }), {
        existing: "reuse",
    });

    const { peer } = usePeer();
    const devices = useLocal(
        peer ? identities?.program?.connections : undefined,
        peer
            ? {
                  query: {
                      query: new And([
                          new Or([
                              new ByteMatchQuery({
                                  key: ["device1", "publicKey"],
                                  value: peer.identity.publicKey.bytes,
                              }),
                              new ByteMatchQuery({
                                  key: ["device2", "publicKey"],
                                  value: peer.identity.publicKey.bytes,
                              }),
                          ]),
                          new BoolQuery({
                              key: "verified",
                              value: true,
                          }),
                      ]),
                  },
                  id: peer.identity.publicKey.hashcode(),
                  debounce: 1e4,
              }
            : undefined
    );

    // Create isMe function to check if a key belongs to one of the user's identities
    const isMe = React.useCallback(
        (identityKey: PublicSignKey | Uint8Array) => {
            if (!peer || !devices) return false;

            // Compare with the current peer's identity
            const keyBytes =
                identityKey instanceof PublicSignKey
                    ? identityKey.bytes
                    : identityKey;

            // Check if the key matches our peer's key directly
            if (
                Buffer.from(peer.identity.publicKey.bytes).equals(
                    Buffer.from(keyBytes)
                )
            ) {
                return true;
            }

            // Check if it matches any of our connected devices
            return devices.some((connection) => {
                return (
                    Buffer.from(connection.device1.publicKey).equals(
                        Buffer.from(keyBytes)
                    ) ||
                    Buffer.from(connection.device2.publicKey).equals(
                        Buffer.from(keyBytes)
                    )
                );
            });
        },
        [peer, devices]
    );

    const memo = React.useMemo<IIdentitiesContext>(
        () => ({
            identities: identities.program,
            devices,
            isMe,
        }),
        [identities?.program, devices, isMe]
    );

    return (
        <IdentitiesContext.Provider value={memo}>
            {children}
        </IdentitiesContext.Provider>
    );
};
