import { forwardRef } from "react";

export type MediaSelectProps = {
    handleSourceTypeChange: (props: {
        type: "upload-media";
        src: string;
    }) => void;
    id?: string;
};

export const MediaSelect = forwardRef<HTMLInputElement, MediaSelectProps>(
    (props, ref) => {
        return (
            <input
                ref={ref} // attach the forwarded ref here
                id={props.id || "media-file-select"}
                hidden
                accept="video/*"
                multiple
                type="file"
                onClick={(event) => {
                    // Reset the input value to allow uploading the same file again
                    (event.target as HTMLInputElement).value = "";
                }}
                onChange={(event) => {
                    const target = event.target as HTMLInputElement;
                    if (target.files && target.files.length > 0) {
                        props.handleSourceTypeChange({
                            type: "upload-media",
                            src: URL.createObjectURL(target.files[0]),
                        });
                    }
                }}
            />
        );
    }
);
