#!/usr/bin/env node
// Stable launcher: tsc rewrites dist/cli.js (mode 644) on every build, which
// would strip the exec bit from a bin that points there directly. This file is
// never regenerated, so it keeps its exec bit and just loads the compiled CLI.
import "../dist/cli.js";
