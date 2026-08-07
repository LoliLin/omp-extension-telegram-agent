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
		// Wait a bounded window for readiness; first start can be slow (sticker catalog
		// downloads + vision pre-recognition, minutes). If not ready in time we do NOT claim
		// failure — the daemon may still be initializing — but never claim success (R6);
		// a dead child is the only hard failure.
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			if (existsSync(sockPath)) break;
			await sleep(500);
		}
		if (!existsSync(sockPath)) {
			if (!pidAlive(child.pid ?? -1)) {
				console.error(`daemon exited during startup; logs: ${logPath}`);
				const tail = readFileSync(logPath, "utf8").trim().split("\n").slice(-15).join("\n");
				if (tail) console.error(tail);
				process.exit(1);
			}
			console.log(`daemon starting (pid ${child.pid}, first start may take minutes: sticker catalog vision pre-recognition); use "bun run src/main.ts status" or ${logPath} to confirm`);
			process.exit(0);
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
		// optional bot filter (REQ-UI-0002): validate against the configured bot list here
		const botId = process.argv[3];
		if (botId) {
			const { loadConfig } = await import("./config.ts");
			try {
				const ids = loadConfig(rootDir).bots.map((b) => b.id);
				if (!ids.includes(botId)) {
					console.error(`unknown bot id "${botId}"; configured bots: ${ids.join(", ") || "(none)"}`);
					process.exit(1);
				}
			} catch (err) {
				console.error(`attach ${botId}: ${(err as Error).message}`);
				process.exit(1);
			}
		}
		process.env.TG_ATTACH_BOT = botId ?? "";
		await import("./tui/index.ts");
		break;
	}
	default:
		console.log("usage: bun run src/main.ts <start [--foreground] | status | stop | attach>");
		process.exit(1);
}
