#!/usr/bin/env node

import { start } from "./cli.js";

// fetch directory argument from process.argv --directory or --dir parameters
const directoryIndex = process.argv.indexOf("--directory");
const directory =
    directoryIndex !== -1 ? process.argv[directoryIndex + 1] : undefined;

start(directory);
