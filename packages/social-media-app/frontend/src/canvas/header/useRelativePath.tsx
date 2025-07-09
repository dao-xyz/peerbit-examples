import { Canvas } from "@giga-app/interface";
import { useEffect, useState } from "react";
import { useCanvases } from "../useCanvas";

export const useRelativePath = (properties: {
    canvas: Canvas;
    disabled?: boolean;
}) => {
    const { leaf } = useCanvases();

    const [path, setPath] = useState<Canvas[]>([]);

    useEffect(() => {
        if (properties.disabled) {
            return;
        }
        // get the path of the canvas that is unique to the viewRoot

        if (!properties.canvas || properties.canvas.closed !== false || !leaf)
            return setPath([] as Canvas[]);
        // filter the path to only include elements that are not in the viewRoot path
        const indexWhereTheRootEnds = properties.canvas.path.findIndex(
            (p) => p.address === leaf.address
        );
        if (indexWhereTheRootEnds === -1) {
            return setPath([] as Canvas[]);
        }
        const pathPromise = properties.canvas.loadPath({
            length: properties.canvas.path.length - indexWhereTheRootEnds - 1,
        });
        pathPromise
            .then((path) => {
                setPath(path);
            })
            .catch((e) => {
                console.error("Error loading path", e);
                setPath([] as Canvas[]);
            });
    }, [
        properties.canvas,
        properties?.canvas?.closed,
        leaf,
        properties.disabled,
    ]);

    return path;
};
