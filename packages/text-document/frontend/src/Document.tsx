import { useProgram } from "@peerbit/react";
import { useEffect, useReducer, useRef } from "react";
import { CollaborativeTextDocument } from "./db";
import { Range } from "@peerbit/string";
import diff from "fast-diff";

// A random ID, but unique for this app
const ID = new Uint8Array([
    30, 222, 227, 78, 164, 10, 61, 8, 21, 176, 122, 5, 79, 110, 115, 255, 233,
    253, 92, 76, 146, 158, 46, 212, 14, 162, 30, 94, 1, 134, 99, 174,
]);

export const Document = () => {
    const testAreaRef = useRef<HTMLTextAreaElement>(undefined);
    const { program } = useProgram(new CollaborativeTextDocument({ id: ID }), {
        existing: "reuse",
    });
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);

    useEffect(() => {
        if (!program?.address) {
            return;
        }
        const listener = async () => {
            let end = testAreaRef.current.selectionEnd;
            const text = await program.string.getValue();
            testAreaRef.current.value = text;
            testAreaRef.current.selectionEnd = end;
            forceUpdate();
        };
        program.string.events.addEventListener("change", listener);

        // initial value
        program.string.getValue().then((v) => {
            testAreaRef.current.value = v;
            forceUpdate();
        });

        return () => {
            program.string.events.removeEventListener("change", listener);
        };
    }, [program?.address]);

    return (
        <textarea
            ref={testAreaRef}
            disabled={!program}
            onInput={async (e) => {
                try {
                    const textField = e.target as HTMLTextAreaElement;
                    const start = textField.selectionStart;
                    let oldContent = await program.string.getValue();
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
                            await program.string.add(
                                "",
                                new Range({
                                    offset: pos,
                                    length: diff[1].length,
                                })
                            );
                        } else {
                            // INSERT
                            await program.string.add(
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
