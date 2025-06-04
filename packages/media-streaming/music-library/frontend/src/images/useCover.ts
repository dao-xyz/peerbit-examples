import { useMemo } from "react";
import { useProgram, useQuery } from "@peerbit/react";
import { ImageItems } from "@peerbit/music-library-utils";

/** returns [coverURL, setCover(id, file)] */
export const useCover = (id?: Uint8Array) => {
    /* open once, reuse */
    const imgs = useProgram<ImageItems>(new ImageItems(), {
        existing: "reuse",
    });

    /* subscribe to THIS id */
    const {
        items: [doc],
    } = useQuery(imgs.program?.documents, {
        query: useMemo(() => ({ query: { id } }), [id]),
        prefetch: true,
        onChange: {
            merge: true,
        },
        remote: {
            eager: true,
            joining: {
                waitFor: 5e3,
            },
        },
    });

    /* blob-url for <img> / background-image */
    const url = useMemo(() => {
        if (!doc) return null;
        const blob = new Blob([doc.img], { type: "image/*" });
        return URL.createObjectURL(blob);
    }, [doc?.img]);

    /** put() + auto resize to max 1024px */
    const setCover = async (file: File) => {
        if (!imgs.program) {
            throw new Error("ImageItems program not open");
        }

        const b = await file.arrayBuffer();
        const view = await new Promise<{ w: number; h: number }>((res, rej) => {
            const i = new Image();
            i.onload = () => res({ w: i.width, h: i.height });
            i.onerror = rej;
            i.src = URL.createObjectURL(file);
        });
        await imgs.program.setImage(id, new Uint8Array(b), view.w, view.h);
    };

    return [url, setCover] as const;
};
