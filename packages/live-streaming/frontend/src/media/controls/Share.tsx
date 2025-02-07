import { FaShare } from "react-icons/fa";

export const Share = (props: { size?: number }) => {
    // make responsive
    // if space is enough show text Share and icon, otherwise show only icon
    return (
        <div className="flex items-center btn-icon">
            <span className="hidden sm:block pr-2">Share</span>
            <FaShare size={props.size} className="" />
        </div>
    );
};
