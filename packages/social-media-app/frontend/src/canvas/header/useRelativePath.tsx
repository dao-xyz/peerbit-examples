import { Canvas, IndexableCanvas } from "@giga-app/interface";
import { useEffect, useState } from "react";
import { useCanvases } from "../useCanvas";
import { WithIndexedContext } from "@peerbit/document";
import { equals } from "uint8arrays";

export const useRelativePath = (properties: {
    canvas: WithIndexedContext<Canvas, IndexableCanvas>;
    disabled?: boolean;
}) => {
    const { leaf } = useCanvases();

    const [path, setPath] = useState<Canvas[]>([]);

    useEffect(() => {
        if (properties.disabled) {
            return;
        }
        // get the path of the canvas that is unique to the viewRoot

        if (!properties.canvas || properties.canvas.initialized || !leaf)
            return setPath([] as Canvas[]);
        // filter the path to only include elements that are not in the viewRoot path
        const indexWhereTheRootEnds = properties.canvas.__indexed.path.findIndex(
            (p) => equals(p, leaf.id)
        );
        if (indexWhereTheRootEnds === -1) {
            return setPath([] as Canvas[]);
        }
        const pathPromise = properties.canvas.loadPath({
            length: properties.canvas.__indexed.path.length - indexWhereTheRootEnds - 1,
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
        properties?.canvas?.initialized,
        leaf,
        properties.disabled,
    ]);

    return path;
};
