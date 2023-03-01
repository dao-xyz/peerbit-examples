import { HashRouter } from "react-router-dom";
import { BaseRoutes } from "./routes";

export const Body = () => {
    return (
        <>
            <HashRouter basename="/">
                <BaseRoutes />
            </HashRouter>
        </>
    );
};
