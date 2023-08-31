import { Name, Names } from "@peerbit/peer-names";
import { usePeer } from "@peerbit/react";
import React, { useContext, useEffect, useRef, useState } from "react";
import { SignatureWithKey, PreHash } from "@peerbit/crypto";
import { getAllKeypairs } from "../keys";

interface INameContext {
    name?: string;
    setName: (
        string: string,
        signers?: ((data: Uint8Array) => Promise<SignatureWithKey>)[]
    ) => Promise<void>;
}

export const NameContext = React.createContext<INameContext>({} as any);
export const useNames = () => useContext(NameContext);
export const NameProvider = ({ children }: { children: JSX.Element }) => {
    const { peer } = usePeer();
    const names = useRef<Names>();
    const [name, setName] = useState<string | undefined>(undefined);
    const memo = React.useMemo<INameContext>(
        () => ({
            name,
            setName: async (name: string) => {
                if (!name) {
                    return;
                }
                console.log("set neam!");
                setName(name);
                const keypair = await getAllKeypairs();
                keypair.map((x) =>
                    names.current.names.put(new Name(x.publicKey, name), {
                        signers: [x.signer(PreHash.NONE)],
                    })
                );
            },
        }),
        [name, peer?.identity?.publicKey?.hashcode()]
    );

    useEffect(() => {
        if (peer) {
            peer.open(
                new Names({
                    // Hardcoded random id that will be the same for every session
                    id: new Uint8Array([
                        207, 170, 86, 93, 156, 169, 74, 169, 163, 162, 0, 15,
                        119, 226, 208, 171, 225, 141, 59, 126, 8, 143, 98, 255,
                        106, 254, 219, 127, 193, 125, 16, 42,
                    ]),
                }),
                {
                    args: {
                        sync: () => true,
                    },
                    existing: "reuse",

                    /*  sync: (entry) => { TODO always sync "my" names
                     for (const s of entry.signatures) {
                         if (s.publicKey.equals(peer.identity.publicKey) || s.publicKey.equals(peer.identity.publicKey)) {
                             return true;
                         }
                     }
                     return false;
                 } */
                }
            ).then(async (db) => {
                db.names.events.addEventListener("change", () => {
                    // TODO make this more performant/smarter
                    db.getName(peer.identity.publicKey).then((n) => {
                        if (n && name !== n.name) {
                            setName(n.name);
                        }
                    });
                });
                console.log("LAOD", db.names.index.size);
                names.current = db;
            });
        }
    }, [peer?.identity.publicKey.hashcode()]);

    return <NameContext.Provider value={memo}>{children}</NameContext.Provider>;
};
