import React, { createContext, useState, useContext } from "react";

// Define the view type
export type ViewType = "chat" | "thread";

// Create the context
const ViewContext = createContext<
    | {
          view: ViewType;
          setView: React.Dispatch<React.SetStateAction<ViewType>>;
      }
    | undefined
>(undefined);

// Custom hook to use the view context
export const useView = () => {
    const context = useContext(ViewContext);
    if (!context) {
        throw new Error("useView must be used within a ViewProvider");
    }
    return context;
};

// Provider component
export const ViewProvider = ({
    children,
    initialView = "chat" as ViewType,
}) => {
    const [view, setView] = useState<ViewType>(initialView);

    // Value object to be provided to consumers
    const value = {
        view,
        setView,
    };

    return (
        <ViewContext.Provider value={value}>{children}</ViewContext.Provider>
    );
};
