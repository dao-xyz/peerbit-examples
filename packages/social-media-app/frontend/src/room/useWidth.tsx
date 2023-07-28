import { useState, useEffect, useRef } from "react";

export default function useWidth(initialWidth: number) {
    const [width, setWidth] = useState(initialWidth);
    const ref = useRef<HTMLDivElement>(null);

    const onWindowResize = () => {
        if (!ref.current) return;
        const node = ref.current;

        if (node.clientWidth != null) {
            setWidth(node.clientWidth);
        }
    };

    useEffect(() => {
        onWindowResize();
    }, [ref.current]);

    useEffect(() => {
        window.addEventListener("resize", onWindowResize);
        // Call to properly set the breakpoint and resize the elements.
        // Note that if you're doing a full-width element, this can get a little wonky if a scrollbar
        // appears because of the grid. In that case, fire your own resize event, or set `overflow: scroll` on your body.
        onWindowResize();
        return () => {
            window.removeEventListener("resize", onWindowResize);
        };
    }, [ref.current]);

    return { ref, width };
}
