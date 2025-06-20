import { MdAdd as FaPlus } from "react-icons/md";
import { SaveButton } from "../SaveCanvasButton";
import { useEditTools } from "./ToolbarContext";
import { IoSaveOutline } from "react-icons/io5";
import { ImageUploadTrigger } from "../../content/native/image/ImageUploadToCanvas";
import { BsCamera } from "react-icons/bs";

export const ToolbarEdit = () => {
    const { appSelectOpen, setAppSelectOpen } = useEditTools();
    const onToggleAppSelect = (open) => {
        if (open != null) {
            setAppSelectOpen(open);
        } else {
            setAppSelectOpen((appSelectOpen) => !appSelectOpen);
        }
    };

    const AddButton = () => (
        <button
            onClick={() => onToggleAppSelect(null)}
            className="btn btn-icon p-0 m-0"
        >
            <FaPlus
                className={`ml-[-2] mt-[-2] w-8 h-8 transition-transform duration-300  ${
                    appSelectOpen ? "rotate-45" : "rotate-0"
                }`}
            />
        </button>
    );

    return (
        <div className="flex flex-col z-20 w-full left-0">
            <div className="flex flex-col h-full">
                <div className="px-1 flex-shrink-0 flex items-center bg-neutral-50 dark:bg-neutral-700">
                    {AddButton()}

                    <ImageUploadTrigger
                        onFileChange={() => onToggleAppSelect(false)}
                        className="ml-auto btn btn-icon btn-icon-md flex items-center justify-center"
                    >
                        <BsCamera />
                    </ImageUploadTrigger>
                    <SaveButton icon={IoSaveOutline} />
                </div>
            </div>
        </div>
    );
};
