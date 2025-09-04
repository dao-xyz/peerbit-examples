import { useEffect } from "react";
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
    const { hasTextElement, insertDefault, canvas, pendingRects } = useCanvas();

    useEffect(() => {
        if (!hasTextElement && canvas && props.draft) {
            console.log("Inserting default text element");
            insertDefault({ once: true, scope: privateScope });
        } else {
            console.log("Not inserting default text element", {
                hasTextElement,
                canvas: !!canvas,
                draft: !!props.draft,
            });
        }
    }, [
        props.draft,
        hasTextElement,
        canvas?.idString,
        pendingRects.length,
        insertDefault,
        privateScope,
    ]);

    return <CanvasBase {...props} config={config} />;
};
