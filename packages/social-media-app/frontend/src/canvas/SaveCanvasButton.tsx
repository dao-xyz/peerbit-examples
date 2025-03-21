import { BsSend } from "react-icons/bs";
import { useCanvas } from "./CanvasWrapper";
import { ComponentType } from "react";

interface SaveButtonProps {
    icon?: ComponentType<{ size?: number }>;
    className?: string;
    onClick?: () => void;
}

export const SaveButton = ({
    icon: Icon = BsSend,
    className,
    onClick,
}: SaveButtonProps) => {
    const { savePending } = useCanvas();
    return (
        <div className={"flex-shrink-0 " + (className ?? "")}>
            <button
                onClick={() => {
                    savePending();
                    onClick?.();
                }}
                className={"btn-icon btn-icon-md " + className}
                aria-label="Send"
            >
                <Icon size={30} />
            </button>
        </div>
    );
};
