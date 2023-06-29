import { Name, Names } from "@peerbit/peer-names";
import { usePeer } from "@peerbit/react";
import React, { useContext, useEffect, useRef, useState } from "react";
import { Spaces } from "./canvas/db";

/* 

const { peer } = usePeer();
    let spaces = useRef<Promise<Spaces>>(null);
    let [canvases, setCanvases] = useState<Canvas[]>([]);
    const [textInput, setTextInput] = useState("");
    const handleTextInputChange = (event) => {
        setTextInput(event.target.value);
    };

    useEffect(() => {
        if (spaces.current || !peer) {
            return;
        }
        spaces.current = peer
            .open(new Spaces(), { sync: () => true })
            .then(async (result) => {
                result.canvases.events.addEventListener(
                    "change",
                    async (_change) => {
                        setCanvases(
                            [...result.canvases.index.index.values()].map(
                                (x) => x.value
                            )
                        );
                    }
                );

                await result.load();
                setInterval(async () => {
                    await result.canvases.index.search(
                        new SearchRequest({ query: [] }),
                        { remote: { sync: true, amount: 2 } }
                    );
                }, 2000);
                return result;
            });
    }, [peer?.identity.toString()]);

*/
interface ISpaceContext {
    spaces?: Spaces;
}

export const SpaceContext = React.createContext<ISpaceContext>({} as any);
export const userSpaces = () => useContext(SpaceContext);
export const SpaceProvider = ({ children }: { children: JSX.Element }) => {
    const { peer } = usePeer();
    const [spaces, setSpaces] = useState<Spaces>(undefined);
    const loading = useRef<Promise<void>>();
    const memo = React.useMemo<ISpaceContext>(
        () => ({
            spaces,
        }),
        [spaces?.id.toString()]
    );

    useEffect(() => {
        if (spaces || !peer || loading.current) {
            return;
        }
        loading.current = peer
            .open(new Spaces(), {
                args: {
                    sync: () => true,
                },
            })
            .then(async (result) => {
                setSpaces(result);
            })
            .then(() => {
                loading.current = undefined;
            });
    }, [peer?.identity?.toString()]);

    return (
        <SpaceContext.Provider value={memo}>{children}</SpaceContext.Provider>
    );
};
