import { PeerProvider, usePeer } from "@peerbit/react";
import { useEffect, useReducer, useRef } from "react";
import { CollaborativeTextDocument } from "./db";
import { Range } from "@peerbit/string";
import diff from "fast-diff";
import TextareaAutosize from 'react-textarea-autosize';
import { AppClient } from '@dao-xyz/app-sdk'


// A random ID, but unique for this app
const ID = new Uint8Array([
    30, 222, 227, 78, 164, 10, 61, 8, 21, 176, 122, 5, 79, 110, 115, 255, 233,
    253, 92, 76, 146, 158, 46, 212, 14, 162, 30, 94, 1, 134, 99, 174,
]);



const client = new AppClient({ onResize: () => { }, targetOrigin: '*' });

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
        peer?.open(new CollaborativeTextDocument({ id: ID }), {
            existing: "reuse",
        })
            .then((d) => {
                d.string.events.addEventListener("change", async () => {
                    testAreaRef.current.value = await d.string.getValue();
                    forceUpdate();
                });

                doc.current = d;
                // initial value
                d.string.getValue().then((v) => {
                    testAreaRef.current.value = v;
                    forceUpdate();
                });
            })
            .finally(() => {
                loadingRef.current = false;
            });
    }, [peer?.peerId.toString()]);

    /*     useEffect(() => {
            if (!testAreaRef) {
                return;
            }
            console.log("AUTORESIZE", testAreaRef)
            autosize(testAreaRef.current, { maximumRows: 5, assumeRendered: true });
    
        }, [testAreaRef]) */

    return (

        <div data-iframe-height className="fit-content">
            <TextareaAutosize

                ref={testAreaRef}
                disabled={!doc.current}
                onHeightChange={(e, meta) => {
                    const height = window.getComputedStyle(testAreaRef.current).height
                    const width = window.getComputedStyle(testAreaRef.current).width
                    client.send({ type: 'size', height: Number(height.substring(0, height.length - 2)), width: Number(width.substring(0, width.length - 2)) })
                }}
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
                className="w-full border-none outline-none p-1 box-border min-h-1"
            ></TextareaAutosize>
        </div>

    );
};
