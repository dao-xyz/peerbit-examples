import { type ReactNode } from "react";
import { useCanvases } from "../canvas/useCanvas";
import { Reply } from "../canvas/Reply";

interface ExpandedContextProps {
    children?: ReactNode;
    onClick?: () => void;
}

const ExpandedContext = ({ children, onClick }: ExpandedContextProps) => {
    const { path } = useCanvases();
    return (
        <div className="flex flex-col">
            {path.slice(1).map((p, i) => (
                <Reply
                    onClick={onClick}
                    key={i}
                    index={i}
                    canvas={p as any}
                    variant="tiny"
                />
            ))}
        </div>
    );
};

export default ExpandedContext;
