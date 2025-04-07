import { useView } from "../../view/ViewContex";
import { Canvas } from "../Canvas";
import { CanvasWrapper } from "../CanvasWrapper";
import { Header } from "../header/Header";

export const DetailedView = () => {
    const { canvases, viewRoot } = useView();

    return (
        <div className="max-w-[876px] mx-auto w-full">
            {canvases.length > 1 && (
                <Header
                    variant="large"
                    canvas={viewRoot}
                    className="mb-2 px-4"
                />
            )}
            <CanvasWrapper canvas={viewRoot}>
                <Canvas bgBlur fitWidth draft={false} />
            </CanvasWrapper>
        </div>
    );
};
