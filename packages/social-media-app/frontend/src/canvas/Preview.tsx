import { Canvas as CanvasDB } from "@dao-xyz/social";
import { Canvas } from "./Canvas";
import { CanvasWrapper } from "./CanvasWrapper";
export const CanvasPreview = (properties: {
    canvas: CanvasDB;
    width?: number;
    height?: number;
}) => {
    return (
        <CanvasWrapper canvas={properties.canvas}>
            <div className="w-full flex flex-col items-center relative overflow-hidden">
                {/* Real image preview */}
                <Canvas fitHeight />
                <div className="absolute inset-0 -z-10">
                    <div className="relative blur-xl w-full h-full">
                        <Canvas
                            fitHeight
                            fitWidth
                            width={properties.width}
                            height={properties.height}
                        />
                    </div>
                </div>
            </div>
        </CanvasWrapper>
    );
};
