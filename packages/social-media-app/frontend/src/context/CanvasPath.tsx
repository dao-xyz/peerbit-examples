import { useEffect, useState, useRef, Fragment, useLayoutEffect } from "react";
import { useNavigate } from "react-router";
import { useCanvases } from "../canvas/useCanvas";
import { getCanvasPath } from "../routes";
import { Canvas as CanvasDB, LOWEST_QUALITY } from "@giga-app/interface";
import { CanvasWrapper } from "../canvas/CanvasWrapper";
import { CanvasPreview } from "../canvas/Preview";
const BreadCrumb = ({ path }: { path: CanvasDB[] }) => {
    const endMarkerRef = useRef<HTMLSpanElement>(null);

    // scroll to last element in breadcrumb bar
    useLayoutEffect(() => {
        if (endMarkerRef.current) {
            setTimeout(() => {
                endMarkerRef.current?.scrollIntoView({
                    behavior: "instant",
                    block: "nearest",
                    inline: "end",
                });
            }, 300); // TODO make work without timeout
        }
    }, [path]);

    return (
        <div className="flex flex-row justify-start items-center overflow-x-auto w-full  no-scrollbar p-1 pr-0">
            {path?.length > 1 ? (
                path.map((x, ix) => (
                    <Fragment key={ix}>
                        {ix > 1 && <span className="px-1">/</span>}
                        {ix > 0 && (
                            <CanvasWrapper canvas={x} quality={LOWEST_QUALITY}>
                                <CanvasPreview variant="breadcrumb" />
                            </CanvasWrapper>
                        )}
                    </Fragment>
                ))
            ) : (
                <span className="text-neutral-400 dark:text-neutral-600">
                    {"Home"}
                </span>
            )}
            <span ref={endMarkerRef} className="h-full w-1 flex-none block" />
        </div>
    );
};

export const CanvasPath = ({
    isBreadcrumbExpanded,
    setIsBreadcrumbExpanded,
}: {
    isBreadcrumbExpanded: boolean;
    setIsBreadcrumbExpanded: React.Dispatch<React.SetStateAction<boolean>>;
}) => {
    const navigate = useNavigate();
    const { path, root } = useCanvases();

    // Maintain controlled tags state (each tag is an address string)
    const [tags, setTags] = useState(() =>
        (path || [])?.slice(1).map((x) => x.address)
    );

    useEffect(() => {
        // Update tags when the path changes externally.
        setTags(path.slice(1).map((x) => x.address));
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
            navigate(getCanvasPath(newPath[newPath.length - 1]), {});
            setTags(newPath.slice(1).map((x) => x.address));
        }
    };

    // get last 3 elements in path excluding the root
    /*   const lastThreeElements = useMemo(() => {
          const start = Math.max(path.length - 3, 1);
          return path.slice(start);
      }
          , [path]);
   */
    /*   const shouldShowDots = path.length > 3; */

    return (
        <div className="flex flex-row gap-2 h-full items-center overflow-hidden">
            {/*  {lastThreeElements && lastThreeElements.length > 0 && */}
            <button
                className="h-full rounded hover:bg-neutral-200  dark:hover:bg-neutral-700 w-full leading-normal justify-start flex flex-row cursor-pointer items-stretch border border-neutral-400 dark:border-neutral-600 inset-shadow-xs   inset-shadow-neutral-400/30 dark:inset-shadow-neutral-800/30 i overflow-hidden"
                onClick={() =>
                    setIsBreadcrumbExpanded((breadcrumb) => !breadcrumb)
                }
            >
                {/* {shouldShowDots && (
                    <span className="p-1 pr-0 h-full whitespace-nowrap">...  /</span>)} */}

                <BreadCrumb path={path} />
            </button>
            {/* } */}
        </div>
    );
};
