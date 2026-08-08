// Daemon pid file / lock management (REQ-OPS-0001 R4).
// The pid file is created EXCLUSIVELY (openSync "wx") at the earliest moment of daemon
// startup, before any slow init, so a double `start` cannot race two daemons onto the
// same token. `stop`/`status` verify the pid belongs to OUR daemon (cmdline check) so a
// recycled OS pid is never killed.

import { openSync, closeSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, isAbsolute, join, resolve } from "node:path";
import { errorCategory, log } from "../observability/log.ts";

export const PID_PATH = join(process.cwd(), "data", "daemon.pid");

export function readPid(pidPath: string = PID_PATH): number | null {
	if (!existsSync(pidPath)) return null;
	const pid = Number(readFileSync(pidPath, "utf8").trim());
	return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function processCommand(pid: number): string | null {
	try {
		return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3000 }).trim();
	} catch {
		return null;
	}
}

function processCwd(pid: number): string | null {
	try {
		const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 3000 });
		return output.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
	} catch {
		return null;
	}
}

function daemonEntry(command: string): string | null {
	const args = command.trim().split(/\s+/);
	if (basename(args[0] ?? "") !== "bun") return null;
	const entry = args[1] === "run" ? args[2] : args[1];
	if (!entry) return null;
	const unquoted = entry.replace(/^["']|["']$/g, "");
	return /(?:^|\/)daemon\/index(?:\.ts)?$/.test(unquoted) ? unquoted : null;
}

/** True only for a daemon entry running from this repository; recycled/other-repo pids are refused. */
export function isOurDaemon(pid: number, rootDir: string = process.cwd()): boolean {
	const command = processCommand(pid);
	if (!command) return false;
	const entry = daemonEntry(command);
	if (!entry) return false;
	const root = resolve(rootDir);
	if (isAbsolute(entry) && resolve(entry) === join(root, "src/daemon/index.ts")) return true;
	const cwd = processCwd(pid);
	return cwd != null && resolve(cwd) === root && resolve(cwd, entry).startsWith(`${root}/`);
}

/** Enumerate every live daemon from this repository, including an orphan missing from daemon.pid. */
export function listOurDaemons(rootDir: string = process.cwd()): number[] {
	try {
		const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 3000 });
		const candidates = output
			.split("\n")
			.filter((line) => daemonEntry(line.replace(/^\s*\d+\s+/, "")) != null)
			.map((line) => Number(line.trim().match(/^(\d+)/)?.[1] ?? 0))
			.filter((pid) => pid > 0 && pid !== process.pid);
		return [...new Set(candidates.filter((pid) => pidAlive(pid) && isOurDaemon(pid, rootDir)))].sort((a, b) => a - b);
	} catch {
		return [];
	}
}

/** True when a daemon is actually running (pid present, alive and ours). */
export function isDaemonRunning(pidPath: string = PID_PATH): boolean {
	const pid = readPid(pidPath);
	return pid != null && pidAlive(pid) && isOurDaemon(pid);
}

/**
 * Acquire the exclusive pid lock. Exits the process when another daemon holds it.
 * Stale pid files (dead or foreign process) are removed and retried once.
 * The returned fd keeps the lock held for the daemon's lifetime.
 */
export function acquirePidLock(dataDir: string): number {
	mkdirSync(dataDir, { recursive: true });
	const pidPath = join(dataDir, "daemon.pid");
	const tryCreate = (): number => {
		const fd = openSync(pidPath, "wx");
		writeFileSync(pidPath, String(process.pid));
		return fd;
	};
	try {
		return tryCreate();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		const existing = readPid(pidPath);
		if (existing != null && pidAlive(existing) && isOurDaemon(existing)) {
			log.error("daemon", "pid_lock_held", { pid: existing });
			process.stderr.write(`daemon already running (pid ${existing})\n`);
			process.exit(1);
		}
		// stale (dead or foreign process): take it over
		rmSync(pidPath, { force: true });
		try {
			return tryCreate();
		} catch (err2) {
			log.error("daemon", "pid_lock_failed", { category: errorCategory(err2) });
			process.stderr.write("failed to acquire daemon pid lock\n");
			process.exit(1);
		}
	}
}

/** Release the lock on shutdown (only when we own the file). */
export function releasePidLock(pidFd: number, dataDir: string): void {
	try {
		closeSync(pidFd);
	} catch {
		// already closed
	}
	const pidPath = join(dataDir, "daemon.pid");
	if (readPid(pidPath) === process.pid) rmSync(pidPath, { force: true });
}
