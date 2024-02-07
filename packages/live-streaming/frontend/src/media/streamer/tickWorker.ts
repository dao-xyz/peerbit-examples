let timeout: ReturnType<typeof setTimeout> | undefined = undefined;

/**
 * A worker to make ticks work even if the tab is running the background
 */
export interface NextTick {
    type: "next";
    tps: number;
}
export interface Stop {
    type: "stop";
}

self.addEventListener(
    "message",
    function (e) {
        const message: NextTick | Stop = e.data;
        switch (message.type) {
            case "stop": {
                clearTimeout(timeout);
                timeout = undefined;
                break;
            }
            case "next": {
                if (timeout) {
                    return;
                }
                const expectedFrameDuration = 1000 / message.tps;
                timeout = setTimeout(() => {
                    self.postMessage("tick");
                    timeout = undefined;
                }, expectedFrameDuration);
                break;
            }
        }
    },
    false
);
