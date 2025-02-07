import { SharedLog } from "@peerbit/shared-log";
import { useEffect, useState } from "react";
export const useStorageUsage = (log?: SharedLog<any, any>) => {
    const [storage, setStorage] = useState(0);
    useEffect(() => {
        if (!log) {
            return;
        }
        const onJoin = () => {
            log.getMemoryUsage().then((m) => setStorage(Math.round(m * 1e-3)));
        };

        const i2 = setInterval(() => {
            onJoin();
        }, 1000);
        log.events.addEventListener("join", onJoin);
        return () => {
            clearInterval(i2);
            return log.events.removeEventListener("join", onJoin);
        };
    }, [log?.address]);
    return { memory: storage };
};
