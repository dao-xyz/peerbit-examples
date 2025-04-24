import { ProgramClient } from "@peerbit/program";
import { rootDevelopment, Canvas } from "@giga-app/interface";
export interface LifeCycle {
    start: () => Promise<void>;
    stop: () => Promise<void>;
}

export const defaultGigaReplicator = (client: ProgramClient): LifeCycle => {
    let canvas: Canvas | undefined = undefined;

    return {
        start: async () => {
            if (canvas) {
                return;
            }
            canvas = await client.open(rootDevelopment.clone(), {
                existing: "reuse",
            });
            console.log(
                "Starting replicator at canvas root: " + canvas.address
            );
        },
        stop: async () => {
            if (!canvas) {
                return;
            }
            await canvas.close();
        },
    };
};
