import { rectIsStaticImage, rectIsStaticPartialImage } from "../../utils/rect";
import { onlyLowestQuality } from "../utils";
import { CanvasBase, CanvasBaseConfig } from "./CanvasBase";
import { Element } from "@giga-app/interface";


type Props = React.ComponentProps<typeof CanvasBase>;

const filterImages = (rects: Element<any>[]) =>
    onlyLowestQuality(
        rects.filter((r) => rectIsStaticImage(r) || rectIsStaticPartialImage(r))
    );

const config: CanvasBaseConfig = {
    mode: "images",
    containerClass: "gap-2 p-2", // same as before
    frameFit: "cover",
    editModeEnabled: () => false,                 // no edit controls in image grid
    showEditControls: () => false,
    filterRects: filterImages,
    itemWrapperClass: (_rect) =>
        "bg-white rounded-md w-20 h-20 max-w-20 max-h-20 border-[1px] border-neutral-800 overflow-hidden",
};

export const ImageCanvas = (props: Omit<Props, "config">) => {
    return <CanvasBase {...props} config={config} />;
};