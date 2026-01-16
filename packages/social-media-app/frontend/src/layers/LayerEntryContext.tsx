import React, { createContext, useContext } from "react";

type LayerEntry = {
    idx: number;
};

const LayerEntryContext = createContext<LayerEntry>({ idx: 0 });

export const LayerEntryProvider: React.FC<{
    idx: number;
    children: React.ReactNode;
}> = ({ idx, children }) => {
    return (
        <LayerEntryContext.Provider value={{ idx }}>
            {children}
        </LayerEntryContext.Provider>
    );
};

export const useLayerEntry = () => useContext(LayerEntryContext);

