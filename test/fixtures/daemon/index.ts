// pid-lock fixture: mimics the daemon's cmdline (path contains "daemon/index") so
// isOurDaemon() recognizes it. Holds the lock for 30s for exclusivity tests.
// Usage: bun run <this file> <dataDir>
import { acquirePidLock } from "../../../src/daemon/pid.ts";

const fd = acquirePidLock(process.argv[2]);
console.log(`LOCKED ${process.pid}`);
// keep the lock (and the process) alive
await new Promise((r) => setTimeout(r, 30_000));
process.exit(0);
