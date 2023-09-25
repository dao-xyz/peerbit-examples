import { Name, Names } from "@peerbit/peer-names";
import { usePeer, useProgram } from "@peerbit/react";
import React, { useContext, useEffect, useRef, useState } from "react";
import { SignatureWithKey, PreHash } from "@peerbit/crypto";

interface INameContext {
    name?: string;
    setName: (
        string: string,
        signers?: ((data: Uint8Array) => Promise<SignatureWithKey>)[]
    ) => Promise<void>;
    names: Names

}

export const NameContext = React.createContext<INameContext>({} as any);
export const useNames = () => useContext(NameContext);
export const NameProvider = ({ children }: { children: JSX.Element }) => {
    const { peer } = usePeer();
    const [name, setName] = useState<string | undefined>(undefined);
    const { loading, program: db, promise } = useProgram(new Names({
        // Hardcoded random id that will be the same for every session
        id: new Uint8Array([
            207, 170, 86, 93, 156, 169, 74, 169, 163, 162, 0, 15,
            119, 226, 208, 171, 225, 141, 59, 126, 8, 143, 98, 255,
            106, 254, 219, 127, 193, 125, 16, 42,
        ]),

    }), {
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
    })

    useEffect(() => {
        if (!db) { return }

        const fetchMyName = () => db.getName(peer.identity.publicKey).then((n) => {
            console.log("FETCHED NAME", name)
            if (n && name !== n.name) {
                setName(n.name);
            }
        });
        fetchMyName()
        db.names.events.addEventListener("change", fetchMyName);
        return db.names.events.removeEventListener("change", fetchMyName)
    }, [db ? db.closed || db.address : undefined])

    const memo = React.useMemo<INameContext>(
        () => ({
            name,
            setName: async (name: string) => {
                if (!name) {
                    return;
                }
                console.log("set neam!", name);
                setName(name);
                db.names.put(new Name(peer.identity.publicKey, name)).catch((err) => {
                    alert("Failed to save name: " + err.toString())
                })
            },
            names: db
        }),
        [name, db?.address, peer?.identity?.publicKey?.hashcode()]
    );

    return <NameContext.Provider value={memo}>{children}</NameContext.Provider>
}






