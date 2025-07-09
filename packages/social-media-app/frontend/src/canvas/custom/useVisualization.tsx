// CustomizationProvider.tsx
import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@peerbit/react";
import {
    Visualization,
    IndexedVisualization,
    getOwnedByCanvasQuery,
    Canvas,
} from "@giga-app/interface";
import { equals } from "uint8arrays";

export const useVisualization = (properies: { canvas: Canvas }) => {
    const { canvas } = properies;
    const [visualization, setVisualization] = useState<
        Visualization | undefined
    >();

    const query = useMemo(() => {
        return !canvas || canvas.closed
            ? null
            : {
                  query: getOwnedByCanvasQuery(canvas),
              };
    }, [canvas?.closed, canvas?.idString]);

    /* 1. fetch the current saved visualization ------------------- */
    const { items, isLoading } = useQuery(
        canvas?.loadedElements ? canvas?.visualizations ?? null : null,
        {
            query,
            onChange: {
                merge: (ch) => ({
                    added: ch.added.filter((v) =>
                        equals(v.canvasId, canvas.id)
                    ),
                    removed: ch.removed.filter((v) =>
                        equals(v.canvasId, canvas.id)
                    ),
                }),
            },
            resolve: true,
            local: true,
            remote: {
                eager: true,
            },
            prefetch: true,
        }
    );

    useEffect(() => {
        if (items && items.length > 0) {
            // we have a visualization, set it
            const v = items[0] as IndexedVisualization;
            if (canvas && equals(v.canvasId, canvas.id)) {
                setVisualization(v);
            } else {
                setVisualization(undefined);
            }
        } else {
            // no visualization found
            setVisualization(undefined);
        }
    }, [items, canvas?.id]);

    return {
        visualization,
        setVisualization,
        isLoading,
    };
};
