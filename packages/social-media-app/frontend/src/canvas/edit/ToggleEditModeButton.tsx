import * as Toggle from "@radix-ui/react-toggle";
import { useEditModeContext } from "./EditModeProvider";
import { FiEdit } from "react-icons/fi";

export const ToggleEditModeButton: React.FC = () => {
    const { editMode, setEditMode } = useEditModeContext();
    return (
        <Toggle.Root
            onPressedChange={setEditMode}
            pressed={editMode}
            defaultChecked={false}
            className="btn-icon btn-sm btn-toggle btn-toggle-flat border-none  gap-2"
            aria-label="Toggle Edit"
        >
            <FiEdit size={20} />
            <span className="hidden sm:block ">Edit</span>
        </Toggle.Root>
    );
};
