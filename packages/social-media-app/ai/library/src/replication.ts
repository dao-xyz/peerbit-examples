import { ProgramClient } from "@peerbit/program";
import { createRoot, Canvas } from "@giga-app/interface";
export interface LifeCycle {
    start: () => Promise<void>;
    stop: () => Promise<void>;
}

export const defaultGigaReplicator = (client: ProgramClient): LifeCycle => {
    let out: Awaited<ReturnType<typeof createRoot>> | undefined = undefined;

    return {
        start: async () => {
            if (out) {
                return;
            }
            const created = await createRoot(client, { persisted: true });

            out = created;
            console.log(
                "Starting replicator at canvas root: " + out.canvas.idString,
                "capsule: " + out.scope.address
            );
        },
        stop: async () => {
            await out?.scope.close(); // TODO close everthing?
        },
    };
};
