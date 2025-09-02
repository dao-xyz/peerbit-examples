import { MdOutlineCheckCircle } from "react-icons/md"; // “published”
import clsx from "clsx"; // if you don’t already use clsx, swap for template-literal
import { BsSend } from "react-icons/bs";
import { Canvas } from "@giga-app/interface";
import { useState } from "react";

interface PublishStatusButtonProps {
    className?: string;
    canvas: Canvas;

}

export const PublishStatusButton = ({
    className,
    canvas
}: PublishStatusButtonProps) => {

    const [published, setPublished] = useState<boolean>(false);
    const handleToggle = () => {
        if (!published) {
            // TODO - plug in your real “publish” action here
            setPublished(true);
        }
    };

    return (
        <button
            onClick={handleToggle}
            className={clsx(
                "btn btn-sm flex items-center gap-1 px-2 rounded  transition-colors",
                published
                    ? "text-green-500 hover:text-green-600 "
                    : "   " /* bg-yellow-400 hover:bg-yellow-500 text-black */,
                className
            )}
            title={published ? "Published" : "Unpublished – click to publish"}
        >
            {published ? (
                <div className="flex items-center gap-1">
                    <span>Published</span>
                    <MdOutlineCheckCircle size={16} />
                </div>
            ) : (
                <div className="flex items-center gap-1">
                    <span>Publish</span>
                    <BsSend size={16} />
                </div>
            )}
        </button>
    );
};
