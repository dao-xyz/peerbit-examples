import { type ReactNode } from "react";
import { useCanvases } from "../canvas/useCanvas";
import { Reply } from "../canvas/feed/Reply"; // Uses the updated Reply component
import { Canvas } from "@giga-app/interface";

interface ExpandedContextProps {
    children?: ReactNode;
    onClick?: (path: Canvas) => void;
}

const ExpandedContext = ({ onClick: onClickMaybe }: ExpandedContextProps) => {
    const { path } = useCanvases();
    if (path.length === 1)
        return (
            <div>
                You are at the root of giga. You will see your context here when
                you navigate somewhere!
            </div>
        );
    return (
        <div className="flex flex-col gap-4">
            {path.slice(1).map((p, i) => (
                <Reply
                    onClick={onClickMaybe ? () => onClickMaybe?.(p) : undefined}
                    key={i}
                    index={i}
                    canvas={p as any}
                    variant="expanded-breadcrumb"
                    className=" hover:border-2 border-primary-200 dark:border-primary-800  hover:dark:border-primary-500 cursor-pointer"
                />
            ))}
        </div>
    );
};

export default ExpandedContext;
