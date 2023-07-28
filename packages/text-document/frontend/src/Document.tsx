import { PeerProvider, usePeer } from "@peerbit/react";
import { useEffect, useReducer, useRef } from "react";
import { CollaborativeTextDocument } from "./db";
import { Range } from "@peerbit/string";
import diff from "fast-diff";

export const Document = () => {
    const doc = useRef<CollaborativeTextDocument>();
    const testAreaRef = useRef<HTMLTextAreaElement>();
    const loadingRef = useRef(false);
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);

    const { peer } = usePeer();
    useEffect(() => {
        console.log(peer);
        if (loadingRef.current || !peer) {
            return;
        }
        loadingRef.current = true;
        peer?.open(new CollaborativeTextDocument({ id: new Uint8Array(32) }), {
            existing: "reuse",
        })
            .then((d) => {
                d.string.events.addEventListener("change", async () => {
                    testAreaRef.current.innerText = await d.string.getValue();
                    forceUpdate();
                });

                doc.current = d;
                // initial value
                d.string.getValue().then((v) => {
                    testAreaRef.current.innerText = v;
                    forceUpdate();
                });
            })
            .finally(() => {
                loadingRef.current = false;
            });
    }, [peer?.peerId.toString()]);

    return (
        <textarea
            ref={testAreaRef}
            disabled={!doc.current}
            onInput={async (e) => {
                try {
                    const textField = e.target as HTMLTextAreaElement;
                    const start = textField.selectionStart;
                    let oldContent = await doc.current.string.getValue();
                    let content = textField.value;
                    let diffs = diff(oldContent, content, start);
                    let pos = 0;
                    for (let i = 0; i < diffs.length; i++) {
                        let diff = diffs[i];
                        if (diff[0] === 0) {
                            // EQUAL
                            pos += diff[1].length;
                        } else if (diff[0] === -1) {
                            // DELETE
                            await doc.current.string.add(
                                "",
                                new Range({
                                    offset: pos,
                                    length: diff[1].length,
                                })
                            );
                        } else {
                            // INSERT
                            await doc.current.string.add(
                                diff[1],
                                new Range({
                                    offset: pos,
                                    length: diff[1].length,
                                })
                            );
                            pos += diff[1].length;
                        }
                    }
                } catch (error) {
                    console.error("failed to append", error);
                }
            }}
            placeholder="type something"
            className="w-full h-screen border-none outline-none p-1"
        ></textarea>
    );
};
