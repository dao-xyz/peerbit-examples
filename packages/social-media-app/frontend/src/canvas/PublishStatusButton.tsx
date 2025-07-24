import { useState } from "react";
import { HiOutlineNewspaper } from "react-icons/hi2";   // “unpublished”
import { MdOutlineCheckCircle } from "react-icons/md";  // “published”
import clsx from "clsx"; // if you don’t already use clsx, swap for template-literal
import { BsSend } from "react-icons/bs";

interface PublishStatusButtonProps {
    /** start in the “published” state? default: false */
    initialPublished?: boolean;
    className?: string;
}

export const PublishStatusButton = ({ initialPublished = false, className }: PublishStatusButtonProps) => {
    const [published, setPublished] = useState(initialPublished);

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
                "btn flex items-center gap-1 px-2 rounded text-xs  transition-colors",
                published
                    ? "text-green-500 hover:text-green-600 "
                    : "bg-yellow-400 hover:bg-yellow-500  text-black ",
                className
            )}
            title={published ? "Published" : "Unpublished – click to publish"}
        >
            {published ? (
                <>
                    Published
                    <MdOutlineCheckCircle size={16} />
                </>
            ) : (
                <>
                    Publish
                    <BsSend size={16} />

                </>
            )}
        </button>
    );
};