import { Canvas, Element, ElementContent, getOwnedElementsQuery, IndexableElement } from "@giga-app/interface"
import { useEffect, useState } from "react"
import { DocumentsChange } from "@peerbit/document";

export const useCanvasStats = (canvas: Canvas | undefined) => {

    const [isEmpty, setIsEmpty] = useState<boolean>(true);
    useEffect(() => {
        if (!canvas?.initialized) {
            return;
        }

        const checkIfEmpty = async () => {
            const iteratorElements = await canvas.elements.index.iterate({ query: getOwnedElementsQuery(canvas) });
            const oneElement = await iteratorElements.next(1);
            await iteratorElements.close();
            if (oneElement.length > 0) {
                setIsEmpty(false)
            }

            const iteratorReplies = await canvas.replies.index.iterate({ query: getOwnedElementsQuery(canvas) });
            const oneReply = await iteratorReplies.next(1);
            await iteratorReplies.close();
            if (oneReply.length > 0) {
                setIsEmpty(false)
            }

            setIsEmpty(true)
        };

        checkIfEmpty();

        const listener = (e: CustomEvent<DocumentsChange<Element<ElementContent>, IndexableElement>>) => {
            if (e.detail.added.length > 0) {
                for (const added of e.detail.added) {
                    if (canvas.isOwning(added)) {
                        setIsEmpty(false);
                        return;
                    }

                }
            }
            else if (e.detail.removed.length > 0) {
                for (const removed of e.detail.removed) {
                    if (canvas.isOwning(removed)) {
                        checkIfEmpty();
                        return;
                    }
                }

            }
        }
        canvas.elements.events.addEventListener('change', listener)
        return () => {
            canvas.elements.events.removeEventListener('change', listener)
        }

    }, [canvas, canvas?.initialized]);

    return { isEmpty }
}