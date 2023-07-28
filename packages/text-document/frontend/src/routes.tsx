import { Routes, Route } from "react-router";
import { App } from "./App";

export const getNameFromPath = (name: string) => decodeURIComponent(name);

export const USER_BY_KEY_NAME = "/k/:key";
export const NEW_SPACE = "/new";

export function BaseRoutes() {
    return (
        <Routes>
            {/* <Route path={USER_BY_KEY_NAME} element={<Canvas />} /> */}
            <Route path="/*" element={<App />} />
        </Routes>
    );
}
