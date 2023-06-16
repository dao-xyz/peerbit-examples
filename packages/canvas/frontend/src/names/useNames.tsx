import { Name, Names } from "@dao-xyz/peer-names";
import { usePeer } from "@dao-xyz/peerbit-react";
import React, { useContext, useEffect, useRef, useState } from "react";
import { SignatureWithKey, PreHash } from "@dao-xyz/peerbit-crypto";
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
        [name, peer?.identity?.publicKey.toString()]
    );

    useEffect(() => {
        if (peer) {
            peer.open(new Names(), {
                sync: () => true,
                /*  sync: (entry) => { TODO always sync "my" names
                     for (const s of entry.signatures) {
                         if (s.publicKey.equals(peer.identity.publicKey) || s.publicKey.equals(peer.identity.publicKey)) {
                             return true;
                         }
                     }
                     return false;
                 } */
            }).then(async (db) => {
                db.names.events.addEventListener("change", () => {
                    // TODO make this more performant/smarter
                    db.getName(peer.identity.publicKey).then((n) => {
                        if (n && name !== n.name) {
                            setName(n.name);
                        }
                    });
                });
                await db.load();
                console.log("LAOD", db.names.index.size);
                names.current = db;
            });
        }
    }, [peer?.identity.publicKey]);

    return <NameContext.Provider value={memo}>{children}</NameContext.Provider>;
};
