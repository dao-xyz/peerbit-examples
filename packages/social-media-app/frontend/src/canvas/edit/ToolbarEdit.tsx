import { MdAdd as FaPlus } from "react-icons/md";
import { useEditTools } from "./CanvasEditorProvider";
import { ImageUploadTrigger } from "../../content/native/image/ImageUploadToCanvas";
import { BsCamera } from "react-icons/bs";
import { useDraftSession } from "./draft/DraftSession";

export const ToolbarEdit = (properties?: {
    className?: string;
    onSave?: () => void;
    /** shared draft key */
    canvasId: string;
}) => {
    const { appSelectOpen, setAppSelectOpen } = useEditTools();
    const { publish } = useDraftSession()

    const onToggleAppSelect = (open?: boolean | null) => {
        if (open != null) setAppSelectOpen(open);
        else setAppSelectOpen((prev) => !prev);
    };

    const save = async () => {
        if (properties?.onSave) await properties.onSave();
        else await publish();
    };

    const AddButton = () => (
        <button onClick={() => onToggleAppSelect(null)} className="btn btn-icon h-full p-0 m-0">
            <FaPlus
                className={`w-8 h-8 transition-transform duration-300 ${appSelectOpen ? "rotate-45" : "rotate-0"
                    }`}
            />
        </button>
    );

    return (
        <div
            className={`flex px-1 flex-row z-20 w-full left-0 items-center justify-center bg-neutral-50 dark:bg-neutral-700 ${properties?.className || ""
                }`}
        >
            <div className="ml-auto flex flex-row h-full items-center justify-center">
                {AddButton()}
            </div>

            <ImageUploadTrigger
                onFileChange={() => onToggleAppSelect(false)}
                className="btn btn-icon btn-icon-md flex items-center justify-center"
            >
                <BsCamera />
            </ImageUploadTrigger>

            <button onClick={save} className="btn p-2 flex items-center justify-center">
                Save
            </button>
        </div>
    );
};