import React, { useState } from "react";
import { Canvas as CanvasDB } from "@dao-xyz/social";
import { useLocal, usePeer, useProgram } from "@peerbit/react";
import { CanvasPreview } from "./CanvasPreview";

// Radix UI Dropdown components
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import { Canvas } from "./Canvas";

export const Replies = (properties: { canvas: CanvasDB }) => {
    const [sortCriteria, setSortCriteria] = useState("New");
    const replies = useLocal(properties.canvas.replies);

    // Optionally sort replies based on the selected criteria.
    const sortedReplies = [...replies].sort((a, b) => {
        // Replace with sorting logic if needed.
        return 0;
    });

    const peer = usePeer();

    const pendingCanvas = useProgram(
        new CanvasDB({
            publicKey: peer.peer.identity.publicKey,
            parentId: properties.canvas.id,
        })
    );

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
            <div className="flex-grow overflow-auto">
                {sortedReplies.map((reply) => (
                    <div key={reply.id.toString()}>
                        <CanvasPreview canvas={reply} />
                    </div>
                ))}
            </div>

            {/* New response outlet */}
            {pendingCanvas.program?.closed === false && (
                <div className="mt-4">
                    <Canvas canvas={pendingCanvas.program} draft={true} />
                </div>
            )}
        </div>
    );
};
