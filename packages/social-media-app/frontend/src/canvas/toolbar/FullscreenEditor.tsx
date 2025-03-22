import { Canvas } from "../Canvas";
import { useToolbar } from "./Toolbar";

export const FullscreenEditor = () => {
    const { fullscreenEditorActive } = useToolbar();
    if (fullscreenEditorActive)
        return (
            <div className="z-10 absolute inset-0 overflow-auto bg-neutral-50 dark:bg-neutral-950">
                <Canvas
                    fitWidth
                    draft={true}
                    className="w-full h-full"
                    inFullScreen
                />
            </div>
        );
    return null;
};
