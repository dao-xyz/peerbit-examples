import { HashRouter } from "react-router-dom";
import { Header, HEIGHT } from "./Header";
import { BaseRoutes } from "./routes";

export const Body = () => {
    return (
        <HashRouter basename="/">
            <div className="bg-white dark:bg-slate-800d">
                <Header></Header>

                <div
                    /* className={`flex-row h-[calc(100vh - ${HEIGHT}] w-full`} */
                    className="content-container"
                >
                    <div className="w-full">
                        <BaseRoutes />
                    </div>
                </div>
            </div>
        </HashRouter>
    );
};
