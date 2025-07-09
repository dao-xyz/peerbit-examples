import React, { createContext, useContext, ReactNode } from "react";

// Define the shape of the context value
interface EditModeProviderType {
    editMode: boolean;
    setEditMode: React.Dispatch<React.SetStateAction<boolean>>;
}

// Create the context
const EditModeContext = createContext<EditModeProviderType | undefined>(
    undefined
);

// Provider props accept optional thresholds and children
export const EditModeProvider: React.FC<{
    children: ReactNode;
}> = ({ children }) => {
    const [editMode, setEditMode] = React.useState(false);
    return (
        <EditModeContext.Provider value={{ editMode, setEditMode }}>
            {children}
        </EditModeContext.Provider>
    );
};

// Custom hook to consume the context
export const useEditModeContext = (): EditModeProviderType => {
    const context = useContext(EditModeContext);
    if (!context) {
        throw new Error(
            "useToolbarVisibilityContext must be used within a ToolbarVisibilityProvider"
        );
    }
    return context;
};
