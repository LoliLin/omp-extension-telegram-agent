// Daemon pid file / lock management (REQ-OPS-0001 R4).
// The pid file is created EXCLUSIVELY (openSync "wx") at the earliest moment of daemon
// startup, before any slow init, so a double `start` cannot race two daemons onto the
// same token. `stop`/`status` verify the pid belongs to OUR daemon (cmdline check) so a
// recycled OS pid is never killed.

import { openSync, closeSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

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

/** True when the pid's process cmdline contains our daemon entry — a recycled pid is refused. */
export function isOurDaemon(pid: number): boolean {
	try {
		const out = execSync(`ps -p ${pid} -o command=`, { encoding: "utf8", timeout: 3000 });
		return out.includes("src/daemon/index.ts") || out.includes("daemon/index");
	} catch {
		return false;
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
			console.error(`daemon already running (pid ${existing})`);
			process.exit(1);
		}
		// stale (dead or foreign process): take it over
		rmSync(pidPath, { force: true });
		try {
			return tryCreate();
		} catch (err2) {
			console.error(`failed to acquire daemon pid lock at ${pidPath}: ${err2}`);
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
	rmSync(join(dataDir, "daemon.pid"), { force: true });
}
