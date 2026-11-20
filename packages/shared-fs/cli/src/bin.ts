#!/usr/bin/env node

import { exitWhenDone, runCli } from "./index.js";

// runCli settles once the command has finished, its stop included. A timer
// that a dependency's stop left armed must not keep the process alive.
runCli()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => exitWhenDone());
