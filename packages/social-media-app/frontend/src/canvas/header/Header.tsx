import React from "react";
import { ProfileButton } from "../../profile/ProfileButton";
import { Canvas, IndexableCanvas } from "@giga-app/interface";
import RelativeTimestamp from "./RelativeTimestamp";
import { WithIndexedContext } from "@peerbit/document";
import { FaRegComment } from "react-icons/fa";
import { CanvasSettingsButton } from "./CanvasSettingsButton";
import { TinyPath } from "../path/RelativePath";
import { useRelativePath } from "./useRelativePath";
import { IoEnterOutline } from "react-icons/io5";

export const Header = ({
    canvas,
    direction,
    className,
    variant,
    open: open,
    reverseLayout,
    forwardRef,
    detailed,
    showPath,
}: {
    canvas?: WithIndexedContext<Canvas, IndexableCanvas>;
    direction?: "row" | "col";
    className?: string;
    variant: "tiny" | "large" | "medium";
    open?: () => void;
    reverseLayout?: boolean;
    forwardRef?: React.Ref<HTMLDivElement>;
    detailed?: boolean; // detailed view
    showPath?: boolean; // show the path in the header
}) => {
    /* useEffect(() => {
        if (!canvas) return;
        if (canvas.isOrigin) {
            return;
        }
        if (canvas.context) {
            return;
        }
        canvas.loadContext();
    }, [canvas]);
 */
    /*  const countQuery = useMemo(() => {
         return !canvas || canvas.closed
             ? undefined
             : {
                 id: canvas.address.toString(),
                 query: canvas.getCountQuery(),
             };
     }, [canvas?.closed, canvas?.idString]);
 
     const replyCount = useCount(
         canvas?.loadedReplies ? canvas.replies : undefined,
         countQuery
     ); */

    // State for controlling the More Info dialog and its content.

    // load the path

    const controls = (
        <div className="ml-auto flex flex-row ">
            {variant === "large" && !detailed && (
                <>
                    {/* Show comment icon with comment counts if applicable */}

                    <button
                        className="btn flex p-2 flex-row items-center gap-1"
                        onClick={open}
                    >
                        <FaRegComment size={16} />
                        {(canvas as WithIndexedContext<Canvas, IndexableCanvas>)
                            .__indexed?.replies ? (
                            <span className="text-xs">
                                {Number(
                                    (
                                        canvas as WithIndexedContext<
                                            Canvas,
                                            IndexableCanvas
                                        >
                                    ).__indexed.replies
                                )}
                            </span>
                        ) : (
                            <></>
                        )}
                    </button>

                    {/* Show a "go to post" buttom */}
                    <button
                        className="btn flex p-2 flex-row items-center gap-1"
                        onClick={open}
                    >
                        <IoEnterOutline className="ml-[-4px]" size={20} />
                    </button>
                </>
            )}

            {/* Dropdown menu always available */}
            <CanvasSettingsButton canvas={canvas} onOpen={open} />
        </div>
    );

    const relativePath = useRelativePath({ canvas, disabled: !showPath });
    const hasPath = relativePath.length > 0;
    return (
        <div className="flex flex-col w-full  px-2">
            {hasPath && (
                <div className="flex flex-row">
                    <TinyPath path={relativePath} />
                    {controls}
                </div>
            )}

            {canvas && (
                <div
                    ref={forwardRef}
                    className={`flex pt-0 ${
                        reverseLayout ? "flex-row-reverse" : ""
                    } items-center gap-1 ${
                        direction === "col" ? "flex-col" : "flex-row"
                    } ${className ?? ""} ${variant === "large" && "w-full"}`}
                >
                    <div
                        className={`overflow-hidden flex mr-1   ${
                            variant === "tiny" || variant === "medium"
                                ? "rounded-full"
                                : "rounded-lg"
                        }`}
                    >
                        <ProfileButton
                            publicKey={canvas.publicKey}
                            className="h-full "
                            size={
                                variant === "large"
                                    ? 20
                                    : variant === "medium"
                                    ? 16
                                    : 12
                            }
                        />
                    </div>

                    {canvas.loadedContext && (
                        <div className="px-1">
                            <RelativeTimestamp
                                timestamp={
                                    new Date(
                                        Number(
                                            canvas.context.created /
                                                BigInt(1000000)
                                        )
                                    )
                                }
                                className={
                                    variant === "large" || variant === "medium"
                                        ? "text-sm"
                                        : "text-xs"
                                }
                            />
                        </div>
                    )}
                    {!hasPath && controls}
                </div>
            )}
        </div>
    );
};
