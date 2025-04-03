import { CanvasAndReplies } from "./canvas/reply/CanvasAndReplies";
import { ViewProvider } from "./view/ViewContex";

export const Home = () => {
    return (
        <>
            <ViewProvider>
                <CanvasAndReplies />
            </ViewProvider>
        </>
    );
};
