import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DaemonController,
	redactDaemonLog,
	tryAcquireControlLock,
	type DaemonControlLock,
	type DaemonControlPort,
} from "../src/daemon/control.ts";

class FakeControlPort implements DaemonControlPort {
	time = 0;
	pid: number | null = null;
	pidFile = false;
	socket = false;
	ready = false;
	spawnPid = 200;
	spawnLives = true;
	logTail = "";
	lockHeld = false;
	events: string[] = [];
	alive = new Set<number>();
	ours = new Set<number>();
	onSleep: ((port: FakeControlPort) => void) | null = null;
	sleepGate: Promise<void> | null = null;

	now(): number { return this.time; }
	async sleep(ms: number): Promise<void> {
		this.events.push(`sleep:${ms}`);
		if (this.sleepGate) await this.sleepGate;
		this.time += ms;
		this.onSleep?.(this);
	}
	readPid(): number | null { return this.pid; }
	pidFileExists(): boolean { return this.pidFile; }
	pidAlive(pid: number): boolean { return this.alive.has(pid); }
	isOurDaemon(pid: number): boolean { return this.ours.has(pid); }
	listOurDaemons(): number[] { return [...this.alive].filter((pid) => this.ours.has(pid)); }
	socketExists(): boolean { return this.socket; }
	removePidFile(): void { this.events.push("remove-pid"); this.pidFile = false; this.pid = null; }
	removeSocket(): void { this.events.push("remove-socket"); this.socket = false; this.ready = false; }
	signal(pid: number): void { this.events.push(`signal:${pid}`); }
	spawnDaemon(): number {
		this.events.push(`spawn:${this.spawnPid}`);
		this.pid = this.spawnPid;
		this.pidFile = true;
		this.ours.add(this.spawnPid);
		if (this.spawnLives) this.alive.add(this.spawnPid);
		return this.spawnPid;
	}
	async socketReady(): Promise<boolean> { this.events.push("socket-ready"); return this.ready; }
	readLogTail(): string { return this.logTail; }
	tryAcquireRestartLock(): DaemonControlLock | null {
		this.events.push("lock");
		if (this.lockHeld) return null;
		this.lockHeld = true;
		return { release: () => { this.events.push("unlock"); this.lockHeld = false; } };
	}
}

function runningPort(pid = 100): FakeControlPort {
	const port = new FakeControlPort();
	port.pid = pid;
	port.pidFile = true;
	port.socket = true;
	port.alive.add(pid);
	port.ours.add(pid);
	return port;
}

function makeReadyOnSpawn(port: FakeControlPort): void {
	const original = port.spawnDaemon.bind(port);
	port.spawnDaemon = () => {
		const pid = original();
		port.socket = true;
		port.ready = true;
		return pid;
	};
}

describe("daemon restart controller (REQ-OPS-0002)", () => {
	test("running daemon releases pid and socket before the one replacement is spawned and connected", async () => {
		const port = runningPort();
		port.onSleep = (value) => {
			value.events.push("old-released");
			value.alive.delete(100);
			value.pid = null;
			value.pidFile = false;
			value.socket = false;
			value.onSleep = null;
		};
		makeReadyOnSpawn(port);
		const result = await new DaemonController(port, { pollIntervalMs: 1 }).restart();

		expect(result).toMatchObject({ ok: true, state: "ready", pid: 200 });
		expect(port.events.filter((event) => event === "signal:100")).toHaveLength(1);
		expect(port.events.filter((event) => event === "spawn:200")).toHaveLength(1);
		expect(port.events.indexOf("signal:100")).toBeLessThan(port.events.indexOf("old-released"));
		expect(port.events.indexOf("old-released")).toBeLessThan(port.events.indexOf("spawn:200"));
		expect(port.events.indexOf("spawn:200")).toBeLessThan(port.events.indexOf("socket-ready"));
		expect(port.lockHeld).toBe(false);
	});

	test("duplicate same-project daemon is stopped with the pid owner before replacement", async () => {
		const port = runningPort();
		port.alive.add(99);
		port.ours.add(99);
		port.onSleep = (value) => {
			value.alive.delete(99);
			value.alive.delete(100);
			value.pid = null;
			value.pidFile = false;
			value.socket = false;
			value.onSleep = null;
		};
		makeReadyOnSpawn(port);
		const result = await new DaemonController(port, { pollIntervalMs: 1 }).restart();
		expect(result.ok).toBe(true);
		expect(port.events.filter((event) => event === "signal:99")).toHaveLength(1);
		expect(port.events.filter((event) => event === "signal:100")).toHaveLength(1);
		expect(port.events.filter((event) => event === "spawn:200")).toHaveLength(1);
	});

	test("stopped and dead-stale states both start after removing stale socket evidence", async () => {
		for (const stale of [false, true]) {
			const port = new FakeControlPort();
			if (stale) {
				port.pid = 77;
				port.pidFile = true;
				port.socket = true;
			}
			makeReadyOnSpawn(port);
			const result = await new DaemonController(port).restart();
			expect(result).toMatchObject({ ok: true, state: "ready", pid: 200 });
			if (stale) {
				expect(port.events.indexOf("remove-pid")).toBeLessThan(port.events.indexOf("spawn:200"));
				expect(port.events.indexOf("remove-socket")).toBeLessThan(port.events.indexOf("spawn:200"));
			}
		}
	});

	test("foreign live pid and shutdown timeout never signal or spawn a replacement", async () => {
		const foreign = runningPort();
		foreign.ours.clear();
		const refused = await new DaemonController(foreign).restart();
		expect(refused.ok).toBe(false);
		expect(refused.lines.join("\n")).toContain("not this project's daemon");
		expect(foreign.events.some((event) => event.startsWith("signal:"))).toBe(false);
		expect(foreign.events.some((event) => event.startsWith("spawn:"))).toBe(false);
		expect(foreign.pidFile).toBe(true);

		const wedged = runningPort();
		const timedOut = await new DaemonController(wedged, { stopTimeoutMs: 2, pollIntervalMs: 1 }).restart();
		expect(timedOut).toMatchObject({ ok: false, state: "failed" });
		expect(timedOut.lines.join("\n")).toContain("no replacement was started");
		expect(wedged.events.filter((event) => event === "signal:100")).toHaveLength(1);
		expect(wedged.events.some((event) => event.startsWith("spawn:"))).toBe(false);
	});

	test("malformed pid beside a socket is ambiguous and never cleaned or replaced", async () => {
		const port = new FakeControlPort();
		port.pidFile = true;
		port.socket = true;
		const result = await new DaemonController(port).restart();
		expect(result).toMatchObject({ ok: false, state: "failed" });
		expect(result.lines.join("\n")).toContain("malformed daemon pid file");
		expect(port.events).not.toContain("remove-pid");
		expect(port.events).not.toContain("remove-socket");
		expect(port.events.some((event) => event.startsWith("spawn:"))).toBe(false);
	});

	test("child early exit is failed with a bounded redacted log; live slow child is only starting", async () => {
		const dead = new FakeControlPort();
		dead.spawnLives = false;
		dead.logTail = `bot_token: 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ\ndeepseek_api_key=sk-supersecret12345\nconfig failed`;
		const failed = await new DaemonController(dead).start();
		expect(failed).toMatchObject({ ok: false, state: "failed" });
		expect(failed.logTail).toContain("[redacted]");
		expect(failed.logTail).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
		expect(failed.logTail).not.toContain("supersecret");

		const slow = new FakeControlPort();
		const starting = await new DaemonController(slow, { startTimeoutMs: 2, pollIntervalMs: 1 }).start();
		expect(starting).toMatchObject({ ok: true, state: "starting", pid: 200 });
		expect(starting.lines.join("\n")).not.toContain("ready");
	});

	test("a concurrent restart is rejected immediately while the first keeps the lock", async () => {
		const port = runningPort();
		let releaseSleep!: () => void;
		port.sleepGate = new Promise<void>((resolve) => { releaseSleep = resolve; });
		port.onSleep = (value) => {
			value.alive.delete(100);
			value.pid = null;
			value.pidFile = false;
			value.socket = false;
			value.sleepGate = null;
			value.onSleep = null;
		};
		makeReadyOnSpawn(port);
		const controller = new DaemonController(port, { pollIntervalMs: 1 });
		const first = controller.restart();
		await Promise.resolve();
		const second = await controller.restart();
		expect(second).toEqual({ ok: false, state: "failed", lines: ["restart already in progress"] });
		expect(port.events.filter((event) => event.startsWith("spawn:"))).toHaveLength(0);
		releaseSleep();
		expect((await first).ok).toBe(true);
		expect(port.events.filter((event) => event === "spawn:200")).toHaveLength(1);
	});

	test("filesystem control lock is exclusive, recoverable and release is idempotent", () => {
		const dir = mkdtempSync(join(tmpdir(), "daemon-control-"));
		const path = join(dir, "restart.lock");
		try {
			const first = tryAcquireControlLock(path);
			expect(first).not.toBeNull();
			expect(tryAcquireControlLock(path)).toBeNull();
			first!.release();
			first!.release();
			const next = tryAcquireControlLock(path);
			expect(next).not.toBeNull();
			next!.release();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("credential redaction stays bounded", () => {
		const text = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n") + "\npassword: hunter2";
		const redacted = redactDaemonLog(text);
		expect(redacted).not.toContain("hunter2");
		expect(redacted.split("\n").length).toBeLessThanOrEqual(15);
		expect(redacted.length).toBeLessThanOrEqual(4096);
	});
});
