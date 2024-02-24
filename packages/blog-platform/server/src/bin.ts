import { start } from "./server.js";

const { close } = await start();
process.on("SIGTERM", () => {
    close().then((err) => {
        process.exit(0);
    });
});
