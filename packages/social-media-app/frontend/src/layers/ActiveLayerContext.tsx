import React, { createContext, useContext } from "react";

const ActiveLayerContext = createContext(true);

export const ActiveLayerProvider: React.FC<{
    active: boolean;
    children: React.ReactNode;
}> = ({ active, children }) => {
    return (
        <ActiveLayerContext.Provider value={active}>
            {children}
        </ActiveLayerContext.Provider>
    );
};

export const useIsActiveLayer = () => useContext(ActiveLayerContext);

