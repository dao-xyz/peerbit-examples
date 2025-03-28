#!/usr/bin/env node

import { start } from "./cli.js";

// Retrieve an optional directory parameter from command-line arguments.
const directoryIndex = process.argv.indexOf("--directory");
const directory =
    directoryIndex !== -1 ? process.argv[directoryIndex + 1] : undefined;

start(directory);
