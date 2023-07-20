import { PeerProvider, usePeer } from "@peerbit/react";
import { useEffect, useRef } from "react";
import { CollaborativeTextDocument } from "./db";
import { Range } from "@peerbit/string";
import diff from "fast-diff";

export const Document = () => {
    const doc = useRef<CollaborativeTextDocument>();
    const { peer } = usePeer();
    useEffect(() => {
        console.log(peer);
        peer?.open(
            new CollaborativeTextDocument({ id: new Uint8Array(32) })
        ).then((d) => {
            doc.current = d;
        });
    }, [peer?.peerId.toString()]);
    return (
        <textarea
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
                        let d = diffs[i];
                        if (d[0] === 0) {
                            // EQUAL
                            pos += d[1].length;
                        } else if (d[0] === -1) {
                            // DELETE
                            await doc.current.string.add(
                                "",
                                new Range({ offset: pos, length: d[1].length })
                            );
                        } else {
                            // INSERT
                            await doc.current.string.add(
                                d[1],
                                new Range({ offset: pos, length: d[1].length })
                            );
                            pos += d[1].length;
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
