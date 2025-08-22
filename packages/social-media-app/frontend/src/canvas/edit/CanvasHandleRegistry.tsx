import React, { createContext, useContext } from "react";
import { CanvasHandle } from "../CanvasWrapper";

/** Whoever owns the provider gets every new handle */
export const CanvasHandleRegistryContext = createContext<
    (handle: CanvasHandle) => void
>(() => {
    /* noop by default */
});

export const useRegisterCanvasHandle = () =>
    useContext(CanvasHandleRegistryContext);
