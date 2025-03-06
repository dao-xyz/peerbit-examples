import React, { useEffect, useMemo, useState } from "react";
import { Canvas as CanvasDB, CanvasValueReference } from "@dao-xyz/social";
import { useLocal, usePeer, useProgram } from "@peerbit/react";
import { CanvasPreview } from "./Preview";

// Radix UI Dropdown components
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import { Canvas } from "./Canvas";

export const Replies = (properties: { canvas?: CanvasDB }) => {
    const [sortCriteria, setSortCriteria] = useState("New");
    const replies = useLocal(properties.canvas?.replies);

    // Optionally sort replies based on the selected criteria.
    const sortedReplies = [...replies].sort((a, b) => {
        return 0;
    });

    const peer = usePeer();

    const [pendingCanvasState, setPendingCanvasState] = useState<
        CanvasDB | undefined
    >(undefined);

    useEffect(() => {
        setPendingCanvasState(
            new CanvasDB({
                publicKey: peer.peer.identity.publicKey,
                parent: new CanvasValueReference({
                    canvas: properties.canvas,
                }),
            })
        );
    }, [properties?.canvas?.idString]);

    const pendingCanvas = useProgram(pendingCanvasState, {
        id: pendingCanvasState?.idString, // we do set the id here so the useProgram hooke will change on pendingCavnasState changes
        keepOpenOnUnmount: true,
    });

    const onSavePending = () => {
        setPendingCanvasState((prev) => {
            // add "comment"
            properties.canvas.replies.put(prev);

            // and initialize a new canvas for the next comment

            return new CanvasDB({
                publicKey: peer.peer.identity.publicKey,
                parent: new CanvasValueReference({ canvas: properties.canvas }),
            });
        });
    };
    return (
        <div className="flex flex-col h-full">
            {/* Toolbar with Radix dropdown */}
            <div className="flex flex-row items-center gap-4 mb-4">
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger className="btn  flex flex-row justify-center items-center">
                        <span>Sort by: {sortCriteria}</span>
                        <ChevronDownIcon className="ml-2" />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content
                        sideOffset={5}
                        style={{
                            padding: "0.5rem",
                            minWidth: "150px",
                        }}
                    >
                        <DropdownMenu.Item
                            className="menu-item"
                            onSelect={() => setSortCriteria("New")}
                        >
                            New
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                            disabled
                            className="menu-item"
                            onSelect={() => setSortCriteria("Old")}
                        >
                            Old
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                            disabled
                            className="menu-item"
                            onSelect={() => setSortCriteria("Best")}
                        >
                            Best
                        </DropdownMenu.Item>
                    </DropdownMenu.Content>
                </DropdownMenu.Root>
            </div>

            {/* Replies list in a scrollable container */}
            {sortedReplies.length > 0 ? (
                <div className="flex flex-col gap-4">
                    {sortedReplies.map((reply) => (
                        <div key={reply.id.toString()}>
                            <CanvasPreview canvas={reply} />
                        </div>
                    ))}
                </div>
            ) : (
                <div className="flex-grow flex items-center justify-center">
                    No replies yet
                </div>
            )}
            {/* New response outlet */}
            <hr className="faded" />
            {pendingCanvas.program?.closed === false && (
                <div className="mt-4">
                    <Canvas
                        canvas={pendingCanvas.program}
                        draft={true}
                        onSave={onSavePending}
                    />
                </div>
            )}
        </div>
    );
};
