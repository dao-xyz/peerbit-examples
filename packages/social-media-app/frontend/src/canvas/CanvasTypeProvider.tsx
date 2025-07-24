import React, {
    createContext,
    useMemo,
    useContext,
    useState,
    useEffect,
} from "react";
import { Canvas, getOwnedByCanvasQuery } from "@giga-app/interface";
import { useQuery } from "@peerbit/react";
import { equals } from "uint8arrays";

/* const useType = (properies: { canvas: Canvas }) => {
    const { canvas } = properies;
    const [type, setType] = useState<Purpose | undefined>();

    const query = useMemo(() => {
        return !canvas || canvas.closed
            ? null
            : {
                query: getOwnedByCanvasQuery(canvas),
            };
    }, [canvas?.closed, canvas?.idString]);

    const { items, isLoading } = useQuery(
        canvas?.loadedElements ? canvas?.types ?? null : null,
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
            // we have a type, set it
            const v = items[0] as Purpose;
            if (canvas && equals(v.canvasId, canvas.id)) {
                setType(v);
            } else {
                setType(undefined);
            }
        } else {
            // no visualization found
            setType(undefined);
        }
    }, [items, canvas?.id]);

    return {
        type,
        setType,
        isLoading,
    };
};

interface TypeCtx {
    canvas?: Canvas;

    isLoading: boolean;
    type: Purpose | undefined;
}
const Ctx = createContext<TypeCtx>({} as any);
export const useTypeContext = () => useContext(Ctx);

export const CanvasTypeProvider: React.FC<{
    canvas: Canvas;
    children: React.ReactNode;
}> = ({ children, canvas }) => {
    const { isLoading, type, setType } = useType({
        canvas,
    });

    const value = useMemo(
        () => ({
            canvas,
            isLoading,
            type,
            setType,
        }),
        [canvas, isLoading, type, setType]
    );

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
 */
