import React, { PointerEvent, MouseEvent, useState, useCallback } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

export const useDownOnClickTriggerFix = (
    onClick?: (evt: MouseEvent<HTMLElement>) => void
) => {
    const [open, setOpen] = useState(false);

    const handlePointerDown = (e: PointerEvent<HTMLElement>) => {
        console.log("Pointer down event:", e);
        if (!open) {
            e.preventDefault();
        }
    };

    // If an onClick callback is provided, execute it when the element is clicked.
    const handleClick = (e: MouseEvent<HTMLElement>) => {
        if (onClick) {
            onClick(e);
        }
        // Prevent the dropdown from closing when clicking inside it.
        setOpen((prev) => !prev);
    };

    return {
        open,
        onClick: handleClick,
        onPointerDown: handlePointerDown,
    };
};
