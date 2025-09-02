// Canvas.tsx (default mixed)
import { CanvasBase, CanvasBaseConfig } from "./CanvasBase";
import { Element } from "@giga-app/interface";

type Props = React.ComponentProps<typeof CanvasBase>;

const config: CanvasBaseConfig = {
    mode: "mixed",
    containerClass: "flex-col gap-4",
    frameFit: "contain",
    editModeEnabled: (global) => global,                   // edit allowed
    showEditControls: (global, n) => global && n > 1,
    filterRects: (rects: Element<any>[]) => rects,        // no filtering
    itemWrapperClass: (_rect) => "",
};

export const Canvas = (props: Omit<Props, "config">) => {
    return <CanvasBase {...props} config={config} />;
};