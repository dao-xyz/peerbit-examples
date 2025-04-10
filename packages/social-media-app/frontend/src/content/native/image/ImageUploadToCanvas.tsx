import { useCanvas } from "../../../canvas/CanvasWrapper";
import { FaCamera } from "react-icons/fa";

export const ImageUploadTrigger = (properties?: {
    children?: JSX.Element;
    className?: string;
    onFileChange?: (files: File[]) => void;
    onClick?: (insertDefault: boolean) => void;
}) => {
    const { insertImage } = useCanvas();
    const handleFileChange = async (
        event: React.ChangeEvent<HTMLInputElement>
    ) => {
        // Convert the FileList into an array immediately.
        const fileArray = event.target.files
            ? Array.from(event.target.files)
            : [];

        if (fileArray.length > 0) {
            // Optionally, loop to support multiple images
            for (const file of fileArray) {
                await insertImage(file, { pending: true });
            }
            // Clear the input value so the same file can be uploaded again if needed.
            event.target.value = "";
        }
        // Call the onFileChange callback if provided.
        if (fileArray.length > 0) {
            properties.onFileChange?.(fileArray);
            properties.onClick?.(false); // we say that this app is used/triggered only if images are uploaded
        }
    };

    return (
        <label className={properties?.className}>
            <input
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={handleFileChange}
            />
            {properties?.children || <FaCamera size={25} />}
        </label>
    );
};
