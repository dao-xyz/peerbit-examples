#!/usr/bin/env node

import { start } from "./cli.js";

start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
