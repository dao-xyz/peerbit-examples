import { Canvas, LOWEST_QUALITY } from "@giga-app/interface";
import { Fragment } from "react/jsx-runtime";
import { CanvasWrapper } from "../CanvasWrapper";
import { CanvasPreview } from "../preview/Preview";
import { JSX } from "react";

const pathClass = "flex h-6 items-center cursor-pointer btn-bouncy ";

export const renderPathElement = (
    c: Canvas,
    pathElement: JSX.Element,
    navigate?: (canvas: Canvas) => void,
    className?: string
) => (
    <Fragment key={c.idString}>
        {pathElement}
        {navigate ? (
            <button
                onClick={() => navigate(c)}
                className={pathClass + className}
            >
                <CanvasWrapper canvas={c} quality={LOWEST_QUALITY}>
                    <CanvasPreview variant="breadcrumb" />
                </CanvasWrapper>
            </button>
        ) : (
            <div className={pathClass}>
                <CanvasWrapper canvas={c} quality={LOWEST_QUALITY}>
                    <CanvasPreview variant="breadcrumb" />
                </CanvasWrapper>
            </div>
        )}
    </Fragment>
);

export const renderPath = (
    path: Canvas[],
    pathElement: JSX.Element,
    navigate?: (canvas: Canvas) => void,
    className?: string
) => {
    return path.map((c) =>
        renderPathElement(c, pathElement, navigate, className)
    );
};

export const smartPath = (
    full: boolean,
    pathElement: JSX.Element,
    path: Canvas[],
    navigate?: (canvas: Canvas) => void,
    className?: string
) => {
    if (full) {
        // if focused, show the whole path *
        return renderPath(path, pathElement, navigate, className);
    } else {
        // if not focused, show last 2 and first and show dots if necessary
        if (path.length <= 3) {
            return renderPath(path, pathElement, navigate, className);
        }

        const first = path[0];
        return (
            <>
                {renderPathElement(first, pathElement, navigate, className)}
                {pathElement}
                <span className={"text-neutral-400 " + className}>…</span>
                {renderPath(path.slice(-2), pathElement, navigate, className)}
            </>
        );
    }
};
