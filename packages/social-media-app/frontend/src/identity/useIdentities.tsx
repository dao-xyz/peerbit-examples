import { useLocal, usePeer, useProgram } from "@peerbit/react";
import React, { useContext } from "react";
import { Connection, Identities } from "@dao-xyz/social";
import { And, BoolQuery, ByteMatchQuery, Or } from "@peerbit/indexer-interface";
import { generateDefaultDeviceName } from "./utils";

interface IIdentitiesContext {
    identities?: Identities;
    devices?: Connection[];
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

    const peerContext = usePeer();
    const { peer } = peerContext;

    const identities = useProgram(new Identities({ baseUrl }), {
        existing: "reuse",
        args: {
            deviceName: generateDefaultDeviceName(),
            tabId:
                peerContext.type === "node" ? peerContext.tabIndex : undefined,
        },
    });

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

    const memo = React.useMemo<IIdentitiesContext>(
        () => ({
            identities: identities.program,
            devices,
        }),
        [identities?.program, devices]
    );

    return (
        <IdentitiesContext.Provider value={memo}>
            {children}
        </IdentitiesContext.Provider>
    );
};
