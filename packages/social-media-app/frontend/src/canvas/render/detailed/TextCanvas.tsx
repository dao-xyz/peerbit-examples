import { rectIsStaticMarkdownText } from "../../utils/rect";
import { CanvasBase, CanvasBaseConfig } from "./CanvasBase";
import { Element } from "@giga-app/interface";

type Props = React.ComponentProps<typeof CanvasBase>;

const filterText = (rects: Element<any>[]) =>
    rects.filter((r) => rectIsStaticMarkdownText(r));

const config: CanvasBaseConfig = {
    mode: "text",
    containerClass: "flex-col gap-4",
    frameFit: undefined,             // keep Frame's default sizing for text
    editModeEnabled: (global) => global,
    showEditControls: (global, n) => global && n > 1,
    filterRects: filterText,
    itemWrapperClass: (_rect) => "",
};

export const TextCanvas = (props: Omit<Props, "config">) => {
    return <CanvasBase {...props} config={config} />;
};