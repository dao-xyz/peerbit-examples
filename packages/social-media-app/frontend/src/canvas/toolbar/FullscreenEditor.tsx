import { Canvas } from "../Canvas";
import { useToolbar } from "./Toolbar";

type FullscreenEditorProps = {
    children: React.ReactNode;
};

export const FullscreenEditor = ({ children }: FullscreenEditorProps) => {
    const { fullscreenEditorActive } = useToolbar();
    if (fullscreenEditorActive)
        return (
            <div className="overflow-auto bg-neutral-50 dark:bg-neutral-950">
                <Canvas
                    fitWidth
                    draft={true}
                    className="w-full h-full"
                    inFullScreen
                />
            </div>
        );
    return <>{children}</>;
};
