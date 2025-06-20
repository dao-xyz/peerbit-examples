import React, { createContext, useContext, ReactNode } from "react";
import { useToolbarVisibility as useInternalToolbarVisibility } from "./useToolbarVisibility";

// Define the shape of the context value
interface ToolbarVisibilityContextType {
    visible: boolean;
    disabled: boolean;
    setDisabled: (disabled: boolean) => void;
    show: () => void;
    unshow: () => void;
    isAtBottom: boolean;
}

// Create the context
const ToolbarVisibilityContext = createContext<
    ToolbarVisibilityContextType | undefined
>(undefined);

// Provider props accept optional thresholds and children
export const ToolbarVisibilityProvider: React.FC<{
    scrollThreshold?: number;
    topThreshold?: number;
    children: ReactNode;
}> = ({ scrollThreshold = 50, topThreshold = 100, children }) => {
    const { visible, setDisabled, disabled, show, unshow, isAtBottom } =
        useInternalToolbarVisibility(scrollThreshold, topThreshold);

    return (
        <ToolbarVisibilityContext.Provider
            value={{ visible, disabled, setDisabled, show, unshow, isAtBottom }}
        >
            {children}
        </ToolbarVisibilityContext.Provider>
    );
};

// Custom hook to consume the context
export const useToolbarVisibilityContext = (): ToolbarVisibilityContextType => {
    const context = useContext(ToolbarVisibilityContext);
    if (!context) {
        throw new Error(
            "useToolbarVisibilityContext must be used within a ToolbarVisibilityProvider"
        );
    }
    return context;
};
