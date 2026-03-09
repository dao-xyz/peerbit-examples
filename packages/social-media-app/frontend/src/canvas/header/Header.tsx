import React, { useEffect, useState } from "react";
import { ProfileButton } from "../../profile/ProfileButton";
import { Canvas, IndexableCanvas } from "@giga-app/interface";
import RelativeTimestamp from "./RelativeTimestamp";
import { WithIndexedContext } from "@peerbit/document";
import { FaRegComment } from "react-icons/fa";
import { CanvasSettingsButton } from "./CanvasSettingsButton";
import { TinyPath } from "../path/RelativePath";
import { useRelativePath } from "./useRelativePath";
import { IoEnterOutline } from "react-icons/io5";

const LIVE_REPLY_REFRESH_MS = 2_000;

const hasRemoteBootstrapTargets = () => {
    if (typeof window === "undefined") return false;
    const bootstraps = (window as any).__DBG_BOOTSTRAP;
    if (Array.isArray(bootstraps)) {
        return bootstraps.length > 0;
    }
    return true;
};

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

    const indexedReplies = Number(
        (canvas as WithIndexedContext<Canvas, IndexableCanvas> | undefined)
            ?.__indexed?.replies ?? 0
    );
    const replyCountRefreshEnabled = variant === "large" && !detailed && !!canvas;
    const [refreshedIndexedReplies, setRefreshedIndexedReplies] =
        useState(indexedReplies);

    useEffect(() => {
        setRefreshedIndexedReplies(indexedReplies);
    }, [canvas?.idString, indexedReplies]);

    useEffect(() => {
        if (!replyCountRefreshEnabled || !canvas) return;

        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const allowRemote = hasRemoteBootstrapTargets();

        const refresh = async () => {
            try {
                const [localRow, remoteRow] = await Promise.all([
                    canvas.nearestScope.replies.index.get(canvas.id, {
                        resolve: false,
                        local: true,
                        remote: false,
                    }),
                    allowRemote
                        ? canvas.nearestScope.replies.index.get(canvas.id, {
                              resolve: false,
                              local: false,
                              remote: {
                                  timeout: LIVE_REPLY_REFRESH_MS,
                              },
                          })
                        : Promise.resolve(undefined),
                ]);
                if (cancelled) return;
                const next = Math.max(
                    Number((localRow as any)?.replies ?? 0),
                    Number((remoteRow as any)?.replies ?? 0)
                );
                if (Number.isFinite(next)) {
                    setRefreshedIndexedReplies(next);
                }
            } catch {
                // Best-effort refresh only; leave the last known indexed value in place.
            } finally {
                if (!cancelled) {
                    timer = setTimeout(refresh, LIVE_REPLY_REFRESH_MS);
                }
            }
        };

        void refresh();

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [canvas?.idString, replyCountRefreshEnabled]);

    // Observer peers are allowed to query/subscribe without replicating full subtrees.
    // Poll the parent indexed row directly so visible badges can reflect the latest
    // local metadata, and add remote fallback when peers are available.
    const replyCount = replyCountRefreshEnabled
        ? Math.max(indexedReplies, refreshedIndexedReplies)
        : indexedReplies;

    const controls = (
        <div className="ml-auto flex flex-row ">
            {variant === "large" && !detailed && (
                <>
                    {/* Show comment icon with comment counts if applicable */}

                    <button
                        className="btn flex p-2 flex-row items-center gap-1"
                        data-testid="open-comments"
                        aria-label="Open comments"
                        onClick={open}
                    >
                        <FaRegComment size={16} />
                        {replyCount > 0 ? (
                            <span className="text-xs">{replyCount}</span>
                        ) : null}
                    </button>

                    {/* Show a "go to post" buttom */}
                    <button
                        className="btn flex p-2 flex-row items-center gap-1"
                        data-testid="open-post"
                        aria-label="Open post"
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
