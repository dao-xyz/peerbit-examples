import { Canvas, LOWEST_QUALITY } from "@giga-app/interface";
import { Fragment, useMemo } from "react";
import { TiChevronRight } from "react-icons/ti";
import { useNavigate } from "react-router";
import { getCanvasPath } from "../../routes";
import { smartPath } from "./utils";

const textStyle = "text-sm text-secondary-700 dark:text-secondary-400 ";

export const TinyPath = (properties: {
    path: Canvas[];
    className?: string;
}) => {
    const { path } = properties;
    const navigate = useNavigate();
    if (path.length === 0) {
        return <></>;
    }

    const renderPath = useMemo(() => {
        const navigateToCanvas = (canvas: Canvas) =>
            navigate(getCanvasPath(canvas));
        return smartPath(
            false,
            <TiChevronRight
                className={"w-4 h-4 text-neutral-400 " + textStyle}
            />,
            path,
            navigateToCanvas,
            textStyle
        );
    }, [path]);

    return (
        <div className="flex flex-row items-center ">{renderPath}</div>
        /* <div
            className={clsx("flex flex-row items-center", properties.className)}
        >
            {path.map((x, ix) => (
                <Fragment key={x.idString}>
                    <div className="w-[13px] h-[13px]">
                        <TiChevronRight className={textStyle} />
                    </div>
                    <button
                        className="hover:underline cursor-pointer"
                        onClick={() => {
                            navigate(getCanvasPath(x));
                        }}
                    >
                        {ix >= 0 && (
                            <CanvasWrapper
                                canvas={x}
                                quality={LOWEST_QUALITY}
                                classNameContent={textStyle}
                            >
                                <CanvasPreview variant="breadcrumb" />
                            </CanvasWrapper>
                        )}
                    </button>
                </Fragment>
            ))}
        </div> */
    );
};
