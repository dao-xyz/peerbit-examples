import { BsSend } from "react-icons/bs";
import { useCanvas } from "./CanvasWrapper";
import { ComponentType } from "react";

interface SaveButtonProps {
    icon?: ComponentType<{ size?: number }>;
    className?: string;
    onSavePending: () => void;
}

export const SaveButton = ({
    icon: Icon = BsSend,
    className,
    onSavePending,
}: SaveButtonProps) => {
    const { savePending } = useCanvas();
    return (
        <div className={"flex-shrink-0 " + (className ?? "")}>
            <button
                onClick={() => {
                    savePending();
                    onSavePending();
                }}
                className="btn-elevated btn-icon btn-icon-md"
                aria-label="Send"
            >
                <Icon size={24} />
            </button>
        </div>
    );
};
