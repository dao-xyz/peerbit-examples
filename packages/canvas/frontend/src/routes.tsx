import { Routes, Route } from "react-router";
import { Canvas } from "./Canvas";


export function BaseRoutes() {
    return (
        <Routes>
            <Route path={"/"} element={<Canvas />} />
        </Routes>
    );
}
