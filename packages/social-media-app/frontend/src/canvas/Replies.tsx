import React, { useRef, useState } from "react";
import { Canvas as CanvasDB } from "@dao-xyz/social";
import { useLocal, usePeer, useProgram } from "@peerbit/react";
import { CanvasPreview } from "./RoomPreview";

// Radix UI Dropdown components
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import { Canvas } from "./Canvas";

export const Replies = (properties: { canvas: CanvasDB }) => {
    const [sortCriteria, setSortCriteria] = useState("New");
    const replies = useLocal(properties.canvas.replies);

    // Optionally sort replies based on the selected criteria.
    // Adjust this logic according to your actual data shape.
    const sortedReplies = [...replies].sort((a, b) => {
        /* if (sortCriteria === "Best") {
            // Assuming each reply has a "score" property.
            return (b.score || 0) - (a.score || 0);
        } else if (sortCriteria === "New") {
            // Assuming each reply has a "createdAt" property.
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        } else if (sortCriteria === "Old") {
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        } */
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
        <>
            {/* Toolbar with Radix dropdown */}
            <div
                className="p-2 flex flex-row items-center gap-4"
                style={{ marginBottom: "1rem" }}
            >
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger className="btn btn-elevated flex flex-row  justify-center items-center">
                        <span>Sort by: {sortCriteria}</span>{" "}
                        <ChevronDownIcon style={{ marginLeft: "0.5rem" }} />
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

            {/* Render sorted replies */}
            {sortedReplies.map((reply) => (
                <div key={reply.id.toString()}>
                    <CanvasPreview canvas={reply} />
                </div>
            ))}

            {/* Show the outlet for a new response  */}

            {pendingCanvas.program?.closed === false && (
                <Canvas canvas={pendingCanvas.program} draft={true} />
            )}
        </>
    );
};
