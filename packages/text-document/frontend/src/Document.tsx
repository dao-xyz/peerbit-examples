import { PeerProvider, usePeer, useProgram } from "@peerbit/react";
import { useEffect, useReducer, useRef } from "react";
import { CollaborativeTextDocument } from "./db.js";
import { Range } from "@peerbit/string";
import diff from "fast-diff";
import TextareaAutosize from 'react-textarea-autosize';
import { AppClient } from '@dao-xyz/app-sdk'
import { useParams } from "react-router-dom";



const client = new AppClient({ onResize: () => { }, targetOrigin: '*' });

export const Document = () => {
    const textRef = useRef<HTMLTextAreaElement>();
    const params = useParams();
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const { program: db } = useProgram<CollaborativeTextDocument>(params.address, { existing: 'reuse', timeout: 3000 })


    useEffect(() => {
        // Tell the parent window that we have opened a text document (only necessary if you want to use @dao-xyz/app-sdk)
        client.send({ type: 'navigate', to: window.location.href })
    }, [])

    useEffect(() => {
        if (!db) {
            return;
        }
        const listener = async () => {
            textRef.current.value = await db.string.getValue();
            forceUpdate();
        };


        db.string.events.addEventListener("change", listener);

        // initial value
        textRef.current.value = ""
        db.string.getValue().then((v) => {
            if (!v) { // TODO why do we need to do this?
                db.string.add(
                    "",
                    new Range({
                        offset: 0,
                        length: 0,
                    })
                )
            }
            textRef.current.value = v || "";
            forceUpdate();
        });

        return () => {
            db.string.events.removeEventListener("change", listener);

        }
    }, [db?.address, textRef.current])

    /*     useEffect(() => {
            if (!testAreaRef) {
                return;
            }
            console.log("AUTORESIZE", testAreaRef)
            autosize(testAreaRef.current, { maximumRows: 5, assumeRendered: true });
    
        }, [testAreaRef]) */
    console.log(db)
    return (

        <div data-iframe-height className="fit-content">
            <TextareaAutosize
                ref={textRef}
                disabled={!db}
                onHeightChange={(e, meta) => {
                    const height = window.getComputedStyle(textRef.current).height
                    const width = window.getComputedStyle(textRef.current).width
                    client.send({ type: 'size', height: Number(height.substring(0, height.length - 2)), width: Number(width.substring(0, width.length - 2)) })
                }}
                onInput={async (e) => {
                    try {

                        const textField = e.target as HTMLTextAreaElement;
                        const start = textField.selectionStart;
                        let oldContent = await db.string.getValue();
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
                                await db.string.add(
                                    "",
                                    new Range({
                                        offset: pos,
                                        length: diff[1].length,
                                    })
                                );
                            } else {
                                // INSERT
                                await db.string.add(
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
