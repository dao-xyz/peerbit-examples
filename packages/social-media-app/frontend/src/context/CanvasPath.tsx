import { useEffect, useState, useRef, Fragment } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useCanvases } from "../canvas/useCanvas";
import { getCanvasPath } from "../routes";
import { Canvas as CanvasDB } from "@dao-xyz/social";
import { CanvasWrapper } from "../canvas/CanvasWrapper";
import { CanvasPreview } from "../canvas/Preview";
import { tw } from "../utils/tailwind";

export const CanvasPath = ({
    isBreadcrumbExpanded,
    setIsBreadcrumbExpanded,
}: {
    isBreadcrumbExpanded: boolean;
    setIsBreadcrumbExpanded: React.Dispatch<React.SetStateAction<boolean>>;
}) => {
    const navigate = useNavigate();
    const location = useLocation();
    const [focus, setFocus] = useState(false);
    const { path, root } = useCanvases();
    const endMarkerRef = useRef<HTMLSpanElement>(null);

    // Maintain controlled tags state (each tag is an address string)
    const [tags, setTags] = useState(() => path.slice(1).map((x) => x.address));

    useEffect(() => {
        // Update tags when the path changes externally.
        setTags(path.slice(1).map((x) => x.address));
        // scroll to last element in breadcrumb bar
        setTimeout(() => {
            endMarkerRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "nearest",
                inline: "end",
            });
        }, 100); // 100ms delay
    }, [path]);

    // When tags change, resolve the new path and navigate if needed.
    const handleTagsChange = async (newTags) => {
        console.log("NEW PATH", newTags);

        // newTags is an array of addresses
        const newPath = await root.getCreateRoomByPath(newTags);
        // Compare newPath with the current path.
        let eq = newPath.length === path.length;
        if (eq) {
            for (let i = 0; i < newPath.length; i++) {
                if (newPath[i] !== path[i]) {
                    eq = false;
                    break;
                }
            }
        }
        if (!eq) {
            console.log(
                "nEW CANVAS PATH",
                getCanvasPath(newPath[newPath.length - 1])
            );
            navigate(getCanvasPath(newPath[newPath.length - 1]), {});
            setTags(newPath.slice(1).map((x) => x.address));
        }
    };

    const renderBreadcrumb = (canvas: CanvasDB, ix) => (
        <CanvasWrapper canvas={canvas}>
            <CanvasPreview variant="breadcrumb" key={ix} />
        </CanvasWrapper>
    );

    return (
        <div className="flex flex-row gap-2 h-full items-center overflow-hidden">
            {path && path.length > 0 && (
                <button
                    className="rounded-lg hover:bg-neutral-200 dark:hover:bg-neutral-700 w-full leading-normal justify-start flex flex-row cursor-pointer items-stretch border border-neutral-950 dark:border-neutral-50 overflow-hidden"
                    onClick={() =>
                        setIsBreadcrumbExpanded((breadcrumb) => !breadcrumb)
                    }
                >
                    <div className="grid grid-flow-col auto-cols-max justify-start items-center overflow-x-auto w-full shrink-0 no-scrollbar p-1 pr-0">
                        {path.slice(0).map((x, ix) => (
                            <Fragment key={ix}>
                                <span
                                    className={tw(
                                        ix < 2 &&
                                            "w-0 overflow-hidden invisible"
                                    )}
                                >
                                    <span className="px-1">/</span>
                                </span>
                                <span
                                    className={tw(
                                        ix === 0 &&
                                            "w-0 overflow-hidden invisible"
                                    )}
                                >
                                    {renderBreadcrumb(x, ix)}
                                </span>
                            </Fragment>
                        ))}
                        <span
                            ref={endMarkerRef}
                            className="h-full w-1 flex-none block"
                        />
                    </div>
                    {isBreadcrumbExpanded && (
                        <span className="text-sm bg-neutral-50 dark:bg-neutral-950 align-middle flex items-center outline outline-neutral-950 dark:outline-neutral-50 rounded-l-lg px-2 sm:px-5">
                            Close
                        </span>
                    )}
                </button>
            )}
        </div>
    );
};
