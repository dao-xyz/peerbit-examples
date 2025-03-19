import { CanvasAndReplies } from "./canvas/CanvasAndReplies";
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
