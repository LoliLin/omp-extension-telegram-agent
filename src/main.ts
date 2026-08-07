// CLI: start | status | stop | attach (attach lands in Phase 4).

import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

const rootDir = process.cwd();
const dataDir = join(rootDir, "data");
const pidPath = join(dataDir, "daemon.pid");
const logPath = join(dataDir, "daemon.log");

function readPid(): number | null {
	if (!existsSync(pidPath)) return null;
	const pid = Number(readFileSync(pidPath, "utf8").trim());
	return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const cmd = process.argv[2];

switch (cmd) {
	case "start": {
		const existing = readPid();
		if (existing && pidAlive(existing)) {
			console.log(`daemon already running (pid ${existing})`);
			process.exit(1);
		}
		if (process.argv.includes("--foreground")) {
			await import("./daemon/index.ts");
			break;
		}
		mkdirSync(dataDir, { recursive: true });
		const logFd = openSync(logPath, "a");
		const child = spawn("bun", ["run", join(rootDir, "src/daemon/index.ts")], {
			cwd: rootDir,
			detached: true,
			stdio: ["ignore", logFd, logFd],
		});
		child.unref();
		console.log(`daemon started (pid ${child.pid}), logs: ${logPath}`);
		break;
	}
	case "status": {
		const pid = readPid();
		if (pid && pidAlive(pid)) console.log(`daemon running (pid ${pid})`);
		else {
			console.log("daemon not running");
			process.exit(1);
		}
		break;
	}
	case "stop": {
		const pid = readPid();
		if (!pid || !pidAlive(pid)) {
			console.log("daemon not running");
			process.exit(1);
		}
		process.kill(pid, "SIGTERM");
		console.log(`sent SIGTERM to ${pid}`);
		break;
	}
	case "attach": {
		await import("./tui/index.ts");
		break;
	}
	default:
		console.log("usage: bun run src/main.ts <start [--foreground] | status | stop | attach>");
		process.exit(1);
}
