import { CanvasAndReplies } from "./canvas/reply/CanvasAndReplies";
import { ViewProvider } from "./view/View";

export const Home = () => {
    return (
        <>
            <ViewProvider>
                <CanvasAndReplies />
            </ViewProvider>
        </>
    );
};
