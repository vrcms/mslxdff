#!/usr/bin/env node
// thin adapter — all logic lives in src/cli (deep module, single inlet run)
import { run } from "../src/cli/index.js";
await run(process.argv.slice(2));
