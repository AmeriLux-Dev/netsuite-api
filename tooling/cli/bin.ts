#!/usr/bin/env node
import { runCli } from './main.js';

process.exit(runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
}));
