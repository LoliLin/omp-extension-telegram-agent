import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { isOurDaemon, listOurDaemons, pidAlive, readPid } from "./pid.ts";
import { rotateLogFile } from "../observability/log.ts";

const DEFAULT_STOP_TIMEOUT_MS = 40_000;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const LOG_TAIL_BYTES = 32 * 1024;
const LOG_TAIL_LINES = 15;

export interface DaemonControlLock {
	release(): void;
}

export interface DaemonControlPort {
	now(): number;
	sleep(ms: number): Promise<void>;
	readPid(): number | null;
	pidFileExists(): boolean;
	pidAlive(pid: number): boolean;
	isOurDaemon(pid: number): boolean;
	listOurDaemons(): number[];
	socketExists(): boolean;
	removePidFile(): void;
	removeSocket(): void;
	signal(pid: number): void;
	spawnDaemon(): number;
	socketReady(): Promise<boolean>;
	readLogTail(): string;
	tryAcquireRestartLock(): DaemonControlLock | null;
}

export interface DaemonControlResult {
	ok: boolean;
	state: "ready" | "starting" | "stopped" | "running" | "failed";
	pid?: number;
	lines: string[];
	logTail?: string;
}

export interface DaemonControllerOptions {
	stopTimeoutMs?: number;
	startTimeoutMs?: number;
	pollIntervalMs?: number;
}

/** Process lifecycle shared by CLI start/restart; all side effects are injectable for replay tests. */
export class DaemonController {
	private readonly stopTimeoutMs: number;
	private readonly startTimeoutMs: number;
	private readonly pollIntervalMs: number;

	constructor(private readonly port: DaemonControlPort, options: DaemonControllerOptions = {}) {
		this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
		this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	}

	async start(): Promise<DaemonControlResult> {
		return this.startUnlocked([]);
	}

	status(): DaemonControlResult {
		const pid = this.port.readPid();
		const discovered = this.liveProjectPids();
		if (pid == null) {
			if (discovered.length > 0) return { ok: false, state: "failed", lines: [`project daemon process(es) ${discovered.join(", ")} are running without the pid lock; run restart to recover`] };
			return { ok: false, state: "stopped", lines: ["daemon not running"] };
		}
		if (!this.port.pidAlive(pid)) {
			if (discovered.length > 0) return { ok: false, state: "failed", pid, lines: [`pid file points to dead pid ${pid}, but project daemon process(es) ${discovered.join(", ")} remain; run restart to recover`] };
			this.port.removePidFile();
			if (this.port.socketExists()) this.port.removeSocket();
			return { ok: false, state: "stopped", lines: [`removed stale daemon state for dead pid ${pid}`, "daemon not running"] };
		}
		if (!this.port.isOurDaemon(pid)) {
			return { ok: false, state: "failed", pid, lines: [`refusing status cleanup: pid ${pid} is not this project's daemon`] };
		}
		const extras = discovered.filter((candidate) => candidate !== pid);
		return { ok: true, state: "running", pid, lines: [`daemon running (pid ${pid})`, ...(extras.length > 0 ? [`warning: duplicate project daemon process(es) ${extras.join(", ")}; run restart to recover`] : [])] };
	}

	stop(): DaemonControlResult {
		const pid = this.port.readPid();
		const discovered = this.liveProjectPids();
		if (pid != null && this.port.pidAlive(pid) && !this.port.isOurDaemon(pid)) {
			return { ok: false, state: "failed", pid, lines: [`refusing to stop: pid ${pid} is not this project's daemon`] };
		}
		const targets = [...new Set([...discovered, ...(pid != null && this.port.pidAlive(pid) ? [pid] : [])])];
		if (targets.length === 0) {
			if (pid != null || this.port.pidFileExists()) this.port.removePidFile();
			if (this.port.socketExists()) this.port.removeSocket();
			return { ok: false, state: "stopped", lines: [...(pid == null ? [] : [`removed stale daemon state for dead pid ${pid}`]), "daemon not running"] };
		}
		if (pid != null && !this.port.pidAlive(pid)) {
			this.port.removePidFile();
		}
		for (const target of targets) this.port.signal(target);
		return { ok: true, state: "stopped", ...(pid == null ? {} : { pid }), lines: [`sent SIGTERM to project daemon pid(s) ${targets.join(", ")}`] };
	}

	async restart(): Promise<DaemonControlResult> {
		const lock = this.port.tryAcquireRestartLock();
		if (!lock) return { ok: false, state: "failed", lines: ["restart already in progress"] };
		try {
			const lines: string[] = [];
			const pid = this.port.readPid();
			if (pid == null && this.port.pidFileExists() && this.port.socketExists()) {
				return { ok: false, state: "failed", lines: ["refusing to restart: malformed daemon pid file exists beside a live-or-stale socket; inspect data/daemon.pid and data/daemon.sock"] };
			}
			if (pid != null && this.port.pidAlive(pid) && !this.port.isOurDaemon(pid)) {
				return { ok: false, state: "failed", pid, lines: [`refusing to restart: pid ${pid} is not this project's daemon`] };
			}
			const targets = [...new Set([
				...this.liveProjectPids(),
				...(pid != null && this.port.pidAlive(pid) ? [pid] : []),
			])];
			if (pid != null && !this.port.pidAlive(pid)) {
				this.port.removePidFile();
				lines.push(`removed stale daemon pid file for dead pid ${pid}`);
			} else if (pid == null && this.port.pidFileExists()) {
				this.port.removePidFile();
				lines.push("removed malformed stale daemon pid file");
			}
			if (targets.length > 0) {
				lines.push(`stopping old daemon pid(s) ${targets.join(", ")}`);
				for (const target of targets) this.port.signal(target);
				lines.push("waiting for every old daemon, pid file and socket to disappear");
				const deadline = this.port.now() + this.stopTimeoutMs;
				while (targets.some((target) => this.port.pidAlive(target)) || this.port.pidFileExists() || this.port.socketExists()) {
					if (this.port.now() >= deadline) {
						return { ok: false, state: "failed", ...(pid == null ? {} : { pid }), lines: [...lines, `daemon shutdown timed out after ${this.stopTimeoutMs}ms; no replacement was started`] };
					}
					await this.port.sleep(this.pollIntervalMs);
				}
			} else {
				if (this.port.socketExists()) {
					this.port.removeSocket();
					lines.push("removed stale daemon socket");
				}
			}
			lines.push("starting new daemon");
			return this.startUnlocked(lines);
		} finally {
			lock.release();
		}
	}

	private async startUnlocked(lines: string[]): Promise<DaemonControlResult> {
		const existing = this.port.readPid();
		if (existing == null && this.port.pidFileExists() && this.port.socketExists()) {
			return { ok: false, state: "failed", lines: [...lines, "refusing to start: malformed daemon pid file exists beside a live-or-stale socket; inspect data/daemon.pid and data/daemon.sock"] };
		}
		if (existing != null && this.port.pidAlive(existing)) {
			if (!this.port.isOurDaemon(existing)) {
				return { ok: false, state: "failed", pid: existing, lines: [...lines, `refusing to start: pid ${existing} is not this project's daemon`] };
			}
			return { ok: false, state: "running", pid: existing, lines: [...lines, `daemon already running (pid ${existing})`] };
		}
		const orphans = this.liveProjectPids();
		if (orphans.length > 0) {
			return { ok: false, state: "failed", lines: [...lines, `project daemon process(es) ${orphans.join(", ")} are running without the current pid lock; run restart instead`] };
		}
		if (existing != null || this.port.pidFileExists()) {
			this.port.removePidFile();
			lines.push(existing == null ? "removed malformed stale daemon pid file" : `removed stale daemon pid file for dead pid ${existing}`);
		}
		if (this.port.socketExists()) {
			this.port.removeSocket();
			lines.push("removed stale daemon socket");
		}

		let childPid: number;
		try {
			childPid = this.port.spawnDaemon();
		} catch {
			return this.startFailure(lines, "failed to spawn daemon; logs: data/daemon.log");
		}
		const deadline = this.port.now() + this.startTimeoutMs;
		while (this.port.now() < deadline) {
			const daemonPid = this.port.readPid();
			if (
				await this.port.socketReady()
				&& daemonPid != null
				&& this.port.pidAlive(daemonPid)
				&& this.port.isOurDaemon(daemonPid)
			) {
				return { ok: true, state: "ready", pid: daemonPid, lines: [...lines, `daemon ready (pid ${daemonPid})`] };
			}
			if (!this.port.pidAlive(childPid)) return this.startFailure(lines, "daemon exited during startup; logs: data/daemon.log", childPid);
			await this.port.sleep(this.pollIntervalMs);
		}
		if (!this.port.pidAlive(childPid)) return this.startFailure(lines, "daemon exited during startup; logs: data/daemon.log", childPid);
		const pid = this.port.readPid() ?? childPid;
		return {
			ok: true,
			state: "starting",
			pid,
			lines: [...lines, `daemon starting (pid ${pid}); use status or data/daemon.log to confirm readiness`],
		};
	}

	private startFailure(lines: string[], message: string, pid?: number): DaemonControlResult {
		const logTail = redactDaemonLog(this.port.readLogTail());
		return { ok: false, state: "failed", ...(pid == null ? {} : { pid }), lines: [...lines, message], ...(logTail ? { logTail } : {}) };
	}

	private liveProjectPids(): number[] {
		return [...new Set(this.port.listOurDaemons().filter((pid) => this.port.pidAlive(pid) && this.port.isOurDaemon(pid)))].sort((a, b) => a - b);
	}
}

/** Redact likely credentials and bound any daemon-log excerpt returned to CLI/Pi. */
export function redactDaemonLog(input: string): string {
	return input
		.replace(/\b\d{5,}:[A-Za-z0-9_-]{10,}\b/g, "[redacted-token]")
		.replace(/\b(?:sk|tf)-[A-Za-z0-9_-]{8,}\b/gi, "[redacted-key]")
		.replace(/((?:token|api[_-]?key|secret|password)[A-Za-z0-9_-]*\s*[:=]\s*)\S+/gi, "$1[redacted]")
		.trim()
		.split("\n")
		.slice(-LOG_TAIL_LINES)
		.join("\n")
		.slice(-4096);
}

export function tryAcquireControlLock(lockPath: string, ownerPid = process.pid): DaemonControlLock | null {
	mkdirSync(dirname(lockPath), { recursive: true });
	const create = (): number => {
		const fd = openSync(lockPath, "wx", 0o600);
		writeFileSync(fd, String(ownerPid));
		return fd;
	};
	let fd: number;
	try {
		fd = create();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		let holder = 0;
		try {
			holder = Number(readFileSync(lockPath, "utf8").trim());
		} catch {
			// A vanished or unreadable lock is retried below.
		}
		if (Number.isFinite(holder) && holder > 0 && pidAlive(holder)) return null;
		rmSync(lockPath, { force: true });
		try {
			fd = create();
		} catch (retryError) {
			if ((retryError as NodeJS.ErrnoException).code === "EEXIST") return null;
			throw retryError;
		}
	}
	let released = false;
	return {
		release: () => {
			if (released) return;
			released = true;
			try { closeSync(fd); } catch { /* already closed */ }
			try {
				if (Number(readFileSync(lockPath, "utf8").trim()) === ownerPid) rmSync(lockPath, { force: true });
			} catch {
				// Another cleanup already removed the lock.
			}
		},
	};
}

function connectUnixSocket(sockPath: string): Promise<boolean> {
	if (!existsSync(sockPath)) return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		const socket = createConnection(sockPath);
		let settled = false;
		const finish = (ready: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(ready);
		};
		socket.setTimeout(250, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function readBoundedLogTail(logPath: string): string {
	if (!existsSync(logPath)) return "";
	let fd: number | null = null;
	try {
		fd = openSync(logPath, "r");
		const size = fstatSync(fd).size;
		const length = Math.min(size, LOG_TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return buffer.toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd != null) try { closeSync(fd); } catch { /* already closed */ }
	}
}

export function createNodeDaemonControlPort(rootDir: string): DaemonControlPort {
	const dataDir = join(rootDir, "data");
	const pidPath = join(dataDir, "daemon.pid");
	const sockPath = join(dataDir, "daemon.sock");
	const logPath = join(dataDir, "daemon.log");
	const lockPath = join(dataDir, "daemon.control.lock");
	return {
		now: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		readPid: () => readPid(pidPath),
		pidFileExists: () => existsSync(pidPath),
		pidAlive,
		isOurDaemon: (pid) => isOurDaemon(pid, rootDir),
		listOurDaemons: () => listOurDaemons(rootDir),
		socketExists: () => existsSync(sockPath),
		removePidFile: () => rmSync(pidPath, { force: true }),
		removeSocket: () => rmSync(sockPath, { force: true }),
		signal: (pid) => process.kill(pid, "SIGTERM"),
		spawnDaemon: () => {
			mkdirSync(dataDir, { recursive: true });
			rotateLogFile(logPath);
			const logFd = openSync(logPath, "a", 0o600);
			try {
				const child = spawn("bun", ["run", join(rootDir, "src/daemon/index.ts")], {
					cwd: rootDir,
					detached: true,
					stdio: ["ignore", logFd, logFd],
				});
				child.once("error", () => { /* readiness polling reports the bounded startup failure */ });
				if (child.pid == null) throw new Error("daemon child has no pid");
				child.unref();
				return child.pid;
			} finally {
				closeSync(logFd);
			}
		},
		socketReady: () => connectUnixSocket(sockPath),
		readLogTail: () => readBoundedLogTail(logPath),
		tryAcquireRestartLock: () => tryAcquireControlLock(lockPath),
	};
}
