import React, { useRef, useEffect } from "react";
import ToolbarContent from "./ToolbarContent"; // Assume you have this component
import { AppSelectPaneInline } from "./AppSelectPaneInline"; // And this one
import { SimpleWebManifest } from "@giga-app/interface"; // Make sure this import works for you
import { useToolbar } from "./ToolbarContext";

export const Toolbar = (props: { className?: string }) => {
    return <ToolbarInner className={props?.className} />;
};

const ToolbarInner = (props: { className: string }) => {
    const { appSelectOpen, setAppSelectOpen } = useToolbar();
    const toolbarRef = useRef<HTMLDivElement>(null);
    const appSelectRef = useRef<HTMLDivElement>(null);

    const handleAppSelected = (app: SimpleWebManifest) => {
        setAppSelectOpen(false);
    };

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                appSelectOpen &&
                toolbarRef.current &&
                !toolbarRef.current.contains(event.target as Node)
            ) {
                // Prevent the event from affecting any other UI
                event.preventDefault();
                event.stopImmediatePropagation();
                event.stopPropagation();
                setAppSelectOpen(false);
            }
        };

        // Attach the listener in the capture phase
        document.addEventListener("click", handleClickOutside, true);
        return () => {
            document.removeEventListener("click", handleClickOutside, true);
        };
    }, [appSelectOpen, setAppSelectOpen]);

    return (
        <div
            ref={toolbarRef}
            className={"w-full flex justify-center " + props.className}
        >
            <div className="flex flex-col w-full rounded-t-lg items-center safe-area-bottom max-w-[876px] bg-neutral-100 dark:bg-neutral-900">
                <ToolbarContent />
                <div
                    ref={appSelectRef}
                    className="overflow-hidden w-full"
                    style={
                        appSelectOpen
                            ? {
                                  height: "100%",
                                  pointerEvents: "auto",
                              }
                            : {
                                  height: "0px",
                                  pointerEvents: "none",
                              }
                    }
                >
                    <AppSelectPaneInline
                        className="p-4 pt-2"
                        onSelected={handleAppSelected}
                    />
                </div>
            </div>
        </div>
    );
};
