// CanvasHandleRegistry.tsx
import React, { createContext, useContext } from "react";
import { CanvasHandle } from "../CanvasWrapper";


export type Registrar = (h: CanvasHandle, meta: { canvasId: string }) => () => void;

export const CanvasHandleRegistryContext = createContext<Registrar | null>(null);
export const useRegisterCanvasHandle = () => useContext(CanvasHandleRegistryContext) ?? (() => () => { });