import React, { createContext, useContext, ReactNode, useEffect } from "react";
import { useToolbarVisibilityContext } from "./ToolbarVisibilityProvider";

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
    editable?: boolean; // Optional prop to enable edit mode by default
}> = ({ children, editable }) => {
    const [editMode, _setEditMode] = React.useState(editable ?? false);
    const { setDisabled: setBottomToolbarDisabled } =
        useToolbarVisibilityContext();

    const setEditMode = (value: boolean | ((prev: boolean) => boolean)) => {
        if (value) {
            setBottomToolbarDisabled(true);
        } else {
            setBottomToolbarDisabled(false);
        }
        _setEditMode(value);
    };

    useEffect(() => {
        if (editable) {
            setEditMode(editable);
        }
    }, [editable]);

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
