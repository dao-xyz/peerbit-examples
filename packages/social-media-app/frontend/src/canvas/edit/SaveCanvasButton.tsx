import { BsSend } from "react-icons/bs";
import { useCanvas } from "../CanvasWrapper";
import { ComponentType } from "react";
import { useDraftManager } from "./draft/DraftManager";
import { useDraftSession } from "./draft/DraftSession";

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
    const { publish } = useDraftSession();
    const { isEmpty } = useCanvas();
    return (
        <button
            onClick={() => {
                publish();
                onClick?.();
            }}
            className={"btn btn-icon btn-icon-md " + className}
            aria-label="Send"
            disabled={isEmpty}
        >
            <Icon size={30} />
        </button>
    );
};
