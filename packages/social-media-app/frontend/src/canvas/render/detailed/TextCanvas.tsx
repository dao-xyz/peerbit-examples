import { useEffect, useRef } from "react";
import { useCanvas } from "../../CanvasWrapper";
import { rectIsStaticMarkdownText } from "../../utils/rect";
import { CanvasBase, type CanvasBaseConfig } from "./CanvasBase";
import { Element } from "@giga-app/interface";
import { PrivateScope } from "../../useScope";

type Props = React.ComponentProps<typeof CanvasBase>;

const filterText = (rects: Element<any>[]) =>
    rects.filter((r) => rectIsStaticMarkdownText(r));

const config: CanvasBaseConfig = {
    mode: "text",
    containerClass: "flex-col gap-4",
    frameFit: undefined, // keep Frame's default sizing for text
    editModeEnabled: (global) => global,
    showEditControls: (global, n) => global && n > 1,
    filterRects: filterText,
    itemWrapperClass: (_rect) => "",
};

export const TextCanvas = (props: Omit<Props, "config">) => {
    const privateScope = PrivateScope.useScope();
    const { hasTextElement, insertDefault, canvas } = useCanvas();

    // Any text rect (committed or pending) in the current draft canvas?
    // Prefer the provider's computed flag to avoid cross-module instanceof issues
    const hasAnyText = hasTextElement;

    // Prevent multiple insertions per canvas id
    const insertedForCanvasRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        insertedForCanvasRef.current = undefined;
    }, [canvas?.idString]);

    useEffect(() => {
        if (!props.draft || !canvas) return;
        if (hasAnyText) return;
        if (insertedForCanvasRef.current === canvas.idString) return;
        // Important: do NOT use `once:true` here. We want to ensure that
        // a text editor appears even if there are already other pending
        // rects (e.g. an image uploaded first). Using `once:true` would
        // skip insertion when images are present, which hides the textarea
        // and breaks tests and UX.
        insertDefault({ scope: privateScope });
        insertedForCanvasRef.current = canvas.idString;
    }, [
        props.draft,
        canvas?.idString,
        hasAnyText,
        insertDefault,
        privateScope,
    ]);

    return <CanvasBase {...props} config={config} />;
};
