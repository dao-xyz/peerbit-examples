import { Canvas, diffCanvases, Scope } from "@giga-app/interface";
import { usePeer } from "@peerbit/react";
import { useEffect, useState } from "react";
import { PrivateScope, PublicScope } from "../useScope";

export const useCanvasPrivateToPublicDifference = (properties: { canvas: Canvas, private?: Scope, public?: Scope }) => {
    const { peer } = usePeer();

    const privateScope = properties?.private || PrivateScope.useScope();
    const publicScope = properties?.public || PublicScope.useScope();

    const [diff, setDiff] = useState<boolean>(false);

    useEffect(() => {
        if (!peer || !properties.canvas || privateScope.closed !== false || publicScope.closed !== false) {
            return;
        }

        // check if we have changes in draft that is not in public, if so we have things to save/do
        const checkChanges = async () => {
            const diff = await diffCanvases(
                {
                    canvas: properties.canvas,
                    scope: privateScope
                },
                {
                    canvas: properties.canvas,
                    scope: publicScope
                });
            setDiff(diff);

        };
        checkChanges()

    }, [properties.canvas, properties?.canvas?.initialized, peer])
    return {
        diff
    };
}