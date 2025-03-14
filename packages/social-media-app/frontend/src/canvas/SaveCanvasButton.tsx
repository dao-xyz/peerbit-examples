import { BsSend } from "react-icons/bs";
import { useCanvas } from "./CanvasWrapper";
import { ComponentType } from "react";

interface SaveButtonProps {
    icon?: ComponentType<{ size?: number }>;
    className?: string;
}

export const SaveButton = ({
    icon: Icon = BsSend,
    className,
}: SaveButtonProps) => {
    const { savePending } = useCanvas();
    return (
        <div className={"flex-shrink-0 " + (className ?? "")}>
            <button
                onClick={() => {
                    savePending();
                }}
                className={"btn-icon btn-icon-md " + className}
                aria-label="Send"
            >
                <Icon size={24} />
            </button>
        </div>
    );
};
