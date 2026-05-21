#!/usr/bin/env node

import { runCli } from "./index.js";

runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
