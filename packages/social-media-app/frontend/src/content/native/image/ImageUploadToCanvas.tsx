import { useCanvas } from "../../../canvas/CanvasWrapper";
import { FaCamera } from "react-icons/fa";

// New component for uploading images
export const ImageUploadTrigger = (properties?: {
    children?: JSX.Element;
    className?: string;
}) => {
    const { insertImage } = useCanvas();
    const handleFileChange = async (
        event: React.ChangeEvent<HTMLInputElement>
    ) => {
        const files = event.target.files;
        if (files && files.length > 0) {
            // Optionally, loop to support multiple images
            for (let i = 0; i < files.length; i++) {
                await insertImage(files[i], { pending: true });
            }
            // Clear the input value so the same file can be uploaded again if needed.
            event.target.value = "";
        }
    };

    return (
        <label className={properties.className}>
            <input
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={handleFileChange}
            />
            {properties.children || <FaCamera size={25} />}
        </label>
    );
};
