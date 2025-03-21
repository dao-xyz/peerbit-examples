import { type ReactNode } from "react";
import { useCanvases } from "../canvas/useCanvas";
import { Reply } from "../canvas/Reply";
import { tw } from "../utils/tailwind";

interface ExpandedContextProps {
    children?: ReactNode;
    onClick?: () => void;
}

const ExpandedContext = ({ children, onClick }: ExpandedContextProps) => {
    const { path } = useCanvases();
    if (path.length === 1)
        return (
            <div>
                You are at the root of giga. You will see you're context here
                when you navigate somewhere!
            </div>
        );
    return (
        <div className="grid grid-cols-[1rem_1fr_1rem]">
            {path.slice(1).map((p, i) => (
                <Reply
                    onClick={onClick}
                    key={i}
                    index={i}
                    canvas={p as any}
                    variant="expanded-breadcrumb"
                />
            ))}
        </div>
    );
};

export default ExpandedContext;
