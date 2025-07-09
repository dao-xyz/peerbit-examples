import { MdAdd as FaPlus } from "react-icons/md";
import { useEditTools } from "./ToolbarContext";
import { ImageUploadTrigger } from "../../content/native/image/ImageUploadToCanvas";
import { BsCamera, BsSend } from "react-icons/bs";
import { useCanvas } from "../CanvasWrapper";
import { SaveButton } from "./SaveCanvasButton";

export const ToolbarInline = (properties?: { className?: string }) => {
    const { isEmpty } = useCanvas();
    const { appSelectOpen, setAppSelectOpen } = useEditTools();
    const onToggleAppSelect = (open) => {
        if (open != null) {
            setAppSelectOpen(open);
        } else {
            setAppSelectOpen((appSelectOpen) => !appSelectOpen);
        }
    };
    const { savePending } = useCanvas();

    const AddButton = () => (
        <button
            onClick={() => onToggleAppSelect(null)}
            className="btn btn-icon h-full p-0 m-0"
        >
            <FaPlus
                className={`w-8 h-8 transition-transform duration-300  ${
                    appSelectOpen ? "rotate-45" : "rotate-0"
                }`}
            />
        </button>
    );

    return (
        <div className={"flex flex-row  items-center " + properties?.className}>
            {AddButton()}

            {/* <button
                                className="btn btn-icon btn-icon-md ml-auto"
                                onClick={() => props.setInlineEditorActive(false)}
                            >
                                <TbArrowsDiagonalMinimize2 />
                            </button> */}
            <ImageUploadTrigger
                onFileChange={() => onToggleAppSelect(false)}
                className="btn btn-icon btn-icon-md flex items-center justify-center"
            >
                <BsCamera />
            </ImageUploadTrigger>

            <SaveButton
                className="ml-auto"
                onClick={
                    () => {}
                    /*  props.setInlineEditorActive(false) */
                }
                icon={BsSend}
            />
        </div>
    );
};
