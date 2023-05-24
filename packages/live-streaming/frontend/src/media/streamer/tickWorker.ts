let last = 0;
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
                break;
            }
            case "next": {
                const expectedFrameDuration = 1000 / message.tps;
                const now = +new Date();
                const currentDuration = now - last;
                last = now;
                const durationLeft = Math.max(
                    expectedFrameDuration - currentDuration,
                    0
                );
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    self.postMessage("tick");
                }, durationLeft);
                break;
            }
        }
    },
    false
);
