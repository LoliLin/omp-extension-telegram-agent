// CLI: start | status | stop | attach (attach lands in Phase 4).

import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readPid, pidAlive, isOurDaemon } from "./daemon/pid.ts";

const rootDir = process.cwd();
const dataDir = join(rootDir, "data");
const pidPath = join(dataDir, "daemon.pid");
const logPath = join(dataDir, "daemon.log");

const cmd = process.argv[2];

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Clean up a stale pid file (dead/foreign process); returns true when removed. */
function cleanStalePid(): boolean {
	const pid = readPid(pidPath);
	if (pid == null) return false;
	if (pidAlive(pid) && isOurDaemon(pid)) return false;
	// dead or foreign: the lock is stale — remove it so start/stop behave correctly
	console.warn(`removing stale daemon pid file (pid ${pid} ${pidAlive(pid) ? "is not our daemon" : "not running"})`);
	rmSync(pidPath, { force: true });
	return true;
}

switch (cmd) {
	case "start": {
		const existing = readPid(pidPath);
		if (existing && pidAlive(existing) && isOurDaemon(existing)) {
			console.log(`daemon already running (pid ${existing})`);
			process.exit(1);
		}
		if (existing) cleanStalePid();
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
		// R6: don't claim success before the daemon is ready — wait for its socket.
		// A config error kills the child within the first second; report the log tail then.
		const sockPath = join(dataDir, "daemon.sock");
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			if (existsSync(sockPath)) break;
			await sleep(250);
		}
		if (!existsSync(sockPath)) {
			console.error(`daemon failed to become ready within 15s; logs: ${logPath}`);
			const tail = readFileSync(logPath, "utf8").trim().split("\n").slice(-15).join("\n");
			if (tail) console.error(tail);
			process.exit(1);
		}
		const pid = readPid(pidPath) ?? child.pid;
		console.log(`daemon started (pid ${pid}), logs: ${logPath}`);
		break;
	}
	case "status": {
		const pid = readPid(pidPath);
		if (pid && pidAlive(pid) && isOurDaemon(pid)) console.log(`daemon running (pid ${pid})`);
		else {
			if (pid) cleanStalePid();
			console.log("daemon not running");
			process.exit(1);
		}
		break;
	}
	case "stop": {
		const pid = readPid(pidPath);
		if (!pid || !pidAlive(pid)) {
			if (pid) cleanStalePid();
			console.log("daemon not running");
			process.exit(1);
		}
		// R4: never signal a pid we don't own (OS pid recycling could kill an unrelated process)
		if (!isOurDaemon(pid)) {
			console.error(`refusing to stop: pid ${pid} is not this project's daemon`);
			cleanStalePid();
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
