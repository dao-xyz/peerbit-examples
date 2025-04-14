import { HIGH_QUALITY } from "@giga-app/interface";
import { useView } from "../../view/ViewContex";
import { Canvas } from "../Canvas";
import { CanvasWrapper } from "../CanvasWrapper";
import { Header } from "../header/Header";

export const DetailedView = (properties: {
    ref?: React.Ref<HTMLDivElement>;
}) => {
    const { canvases, viewRoot } = useView();

    return (
        <div
            className="max-w-[876px] max-height-inherit-children mx-auto w-full"
            ref={properties?.ref}
        >
            {canvases.length > 1 && (
                <Header variant="large" canvas={viewRoot} className="mb-2" />
            )}
            <CanvasWrapper canvas={viewRoot} quality={HIGH_QUALITY}>
                <Canvas bgBlur fitWidth draft={false} />
            </CanvasWrapper>
        </div>
    );
};
