// Daemon pid file / lock management (REQ-OPS-0001 R4).
// The pid file is created EXCLUSIVELY (openSync "wx") at the earliest moment of daemon
// startup, before any slow init, so a double `start` cannot race two daemons onto the
// same token. `stop`/`status` verify the pid belongs to OUR daemon (cmdline check) so a
// recycled OS pid is never killed.
// Ownership reads /proc/<pid>/cmdline (NUL-separated argv) and /proc/<pid>/cwd — unlike
// parsing `ps` output this stays correct when the project path contains spaces.

import {
	openSync,
	closeSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	writeFileSync,
	existsSync,
	rmSync,
	mkdirSync,
} from "node:fs";
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

function processArgv(pid: number): string[] | null {
	if (process.platform === "win32") return windowsProcessArgv(pid);
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8")
			.split("\0")
			.filter((arg) => arg.length > 0);
	} catch {
		return null;
	}
}

/** Windows: Win32_Process has no argv array, so the PowerShell CommandLine is returned as one string. */
function windowsProcessArgv(pid: number): string[] | null {
	try {
		const result = Bun.spawnSync({
			cmd: [
				"powershell",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
			],
		});
		if (result.exitCode !== 0) return null;
		const line = result.stdout.toString("utf8").trim();
		return line ? [line] : null;
	} catch {
		return null;
	}
}

function processCwd(pid: number): string | null {
	if (process.platform === "win32") return null; // Win32_Process exposes no cwd
	try {
		return readlinkSync(`/proc/${pid}/cwd`);
	} catch {
		return null;
	}
}

function daemonEntry(args: string[]): string | null {
	if (args.length === 1) {
		// Windows: single CommandLine string from PowerShell.
		const line = args[0]!;
		const daemon = line.match(/([A-Za-z]:[\\/][^"]*?[\\/]daemon[\\/]index(?:\.ts)?)/);
		if (daemon) return daemon[1]!;
		const foreground = line.match(/([A-Za-z]:[\\/][^"]*?[\\/]main(?:\.ts)?)/);
		if (foreground && /\bstart\b/.test(line) && line.includes("--foreground")) return foreground[1]!;
		return null;
	}
	if (basename(args[0] ?? "") !== "bun") return null;
	const runOffset = args[1] === "run" ? 2 : 1;
	const entry = args[runOffset];
	if (!entry) return null;
	if (/(?:^|\/)daemon\/index(?:\.ts)?$/.test(entry)) return entry;
	if (
		/(?:^|\/)main(?:\.ts)?$/.test(entry) &&
		args[runOffset + 1] === "start" &&
		args.slice(runOffset + 2).includes("--foreground")
	)
		return entry;
	return null;
}

/** True only for a daemon entry running from this repository; recycled/other-repo pids are refused. */
export function isOurDaemon(pid: number, rootDir: string = process.cwd()): boolean {
	const argv = processArgv(pid);
	if (!argv) return false;
	const entry = daemonEntry(argv);
	if (!entry) return false;
	const root = resolve(rootDir);
	if (isAbsolute(entry) && resolve(entry) === join(root, "src/daemon/index.ts")) return true;
	const cwd = processCwd(pid);
	return cwd != null && resolve(cwd) === root && resolve(cwd, entry).startsWith(`${root}/`);
}

/** Enumerate every live daemon from this repository, including an orphan missing from daemon.pid. */
export function listOurDaemons(rootDir: string = process.cwd()): number[] {
	if (process.platform === "win32") return listWindowsOurDaemons(rootDir);
	let procEntries: string[];
	try {
		procEntries = readdirSync("/proc");
	} catch {
		return [];
	}
	const pids: number[] = [];
	for (const name of procEntries) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		if (pid === process.pid) continue;
		const argv = processArgv(pid);
		if (argv != null && daemonEntry(argv) != null && isOurDaemon(pid, rootDir)) pids.push(pid);
	}
	return pids.sort((a, b) => a - b);
}

/** Windows: enumerate all process command lines once and filter for our daemon entry. */
function listWindowsOurDaemons(rootDir: string): number[] {
	try {
		const result = Bun.spawnSync({
			cmd: [
				"powershell",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				'[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
			],
		});
		if (result.exitCode !== 0) return [];
		const root = resolve(rootDir);
		const pids: number[] = [];
		for (const line of result.stdout.toString("utf8").split(/\r?\n/)) {
			const tab = line.indexOf("\t");
			if (tab <= 0) continue;
			const pid = Number(line.slice(0, tab));
			const command = line.slice(tab + 1);
			if (!Number.isInteger(pid) || pid === process.pid) continue;
			const entry = daemonEntry([command]);
			if (entry && isAbsolute(entry) && resolve(entry) === join(root, "src/daemon/index.ts")) pids.push(pid);
		}
		return pids.sort((a, b) => a - b);
	} catch {
		return [];
	}
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
