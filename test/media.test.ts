// Cross-bot media acquisition and Pi attach presentation invariants.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createConnection, createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Tui from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { itemComponent } from "../.pi/extensions/tg-extension.ts";
import { openDb } from "../src/db/db.ts";
import { IpcServer } from "../src/daemon/ipc-server.ts";
import {
	encodeFrame,
	FrameDecoder,
	type EvtItem,
	type MsgItem,
	type ServerMessage,
	type TimelineItem,
	type UsageRun,
} from "../src/ipc.ts";
import { ensureLocalMedia, type MediaDownloadApi } from "../src/media/local-cache.ts";
import { setLogSink } from "../src/observability/log.ts";
import { TimelineClient, type TimelineEvent } from "../src/plugin/timeline.ts";

const temporaryDirectories = new Set<string>();
const logLines: string[] = [];
let restoreLogSink: (() => void) | null = null;

beforeAll(() => {
	restoreLogSink = setLogSink((line) => logLines.push(line));
});

afterAll(() => {
	restoreLogSink?.();
});

afterEach(() => {
	Tui.resetCapabilitiesCache();
	logLines.length = 0;
	for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
	temporaryDirectories.clear();
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.add(directory);
	return directory;
}

function message(overrides: Partial<MsgItem> = {}): MsgItem {
	return {
		kind: "msg",
		ts: 1_786_251_069_000,
		chatId: -1001,
		messageId: 22662,
		senderName: "user",
		username: null,
		isBot: false,
		botId: null,
		text: null,
		mediaKind: "photo",
		stickerEmoji: null,
		mediaPath: null,
		mediaDesc: null,
		fileUniqueId: "shared-photo",
		replyTo: null,
		edited: false,
		...overrides,
	};
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(label)), milliseconds);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("cross-bot media acquisition", () => {
	test("uses the receiving bot's file_id with the matching Bot API", async () => {
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE media (
				file_unique_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				local_path TEXT
			);
			CREATE TABLE media_file_ids (
				bot_id TEXT NOT NULL,
				file_id TEXT NOT NULL,
				file_unique_id TEXT NOT NULL
			);
		`);
		db.query("INSERT INTO media (file_unique_id, kind) VALUES (?, 'photo')").run("shared-photo");
		db.query("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('B', 'file-from-B', ?)").run(
			"shared-photo",
		);

		const calls: string[] = [];
		const apiA: MediaDownloadApi = {
			getFile: async () => {
				calls.push("A:getFile");
				throw new Error("A must not receive B's file_id");
			},
			downloadFile: async () => {
				calls.push("A:downloadFile");
				return new Uint8Array();
			},
		};
		const apiB: MediaDownloadApi = {
			getFile: async (fileId) => {
				calls.push(`B:getFile:${fileId}`);
				return { file_path: "photos/shared.jpg" };
			},
			downloadFile: async (filePath) => {
				calls.push(`B:downloadFile:${filePath}`);
				return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
			},
		};

		try {
			const result = await ensureLocalMedia(db, apiA, "A", "shared-photo", {
				botApis: new Map([
					["A", apiA],
					["B", apiB],
				]),
				cacheDir: join(temporaryDirectory("tg-media-source-"), "media"),
			});
			expect(result.ok).toBe(true);
			expect(calls).toEqual(["B:getFile:file-from-B", "B:downloadFile:photos/shared.jpg"]);
		} finally {
			db.close();
		}
	});
});

describe("Pi attach media presentation", () => {
	test("renders the vision description below the native image", () => {
		Tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		Tui.setCellDimensions({ widthPx: 8, heightPx: 16 });
		const theme = {
			fg: (_color: string, value: string) => value,
			bg: (_color: string, value: string) => value,
			bold: (value: string) => value,
		} as Theme;
		const component = itemComponent(message({ mediaDesc: "recognized text" }), theme, () => ({
			base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			mime: "image/png",
			filename: "/tmp/shared.png",
			revision: "test-revision",
		}));
		const rendered = component.render(80);
		const imageIndex = rendered.findIndex((line) => line.includes("\u001b_G"));
		const visionIndex = rendered.findIndex((line) => line.includes("视觉理解 · recognized text"));
		expect(imageIndex).toBeGreaterThanOrEqual(0);
		expect(visionIndex).toBeGreaterThan(imageIndex);
	});

	test("merges a shared vision update that arrives before a filtered feed message", async () => {
		const directory = temporaryDirectory("tg-vision-order-");
		const socketPath = join(directory, "timeline.sock");
		const server = createServer((socket) => {
			const decoder = new FrameDecoder();
			socket.on("data", (chunk) => {
				for (const frame of decoder.push(chunk) as Array<{ type?: string; filter?: string }>) {
					if (frame.type !== "hello") continue;
					expect(frame.filter).toBe("A");
					socket.write(encodeFrame({ type: "vision_update", fileUniqueId: "shared-photo", text: "recognized" }));
					socket.write(encodeFrame({ type: "append", item: message() }));
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});

		let resolveItem!: (item: TimelineItem) => void;
		const received = new Promise<TimelineItem>((resolve) => {
			resolveItem = resolve;
		});
		const client = new TimelineClient(socketPath, "A", {
			onEvent: (event: TimelineEvent) => {
				if (event.type === "append" && event.items[0]) resolveItem(event.items[0]);
			},
		});
		try {
			expect(await client.connect()).toBe(true);
			const item = await withTimeout(received, 1_000, "filtered vision update timed out");
			expect(item.kind).toBe("msg");
			if (item.kind === "msg") expect(item.mediaDesc).toBe("recognized");
		} finally {
			client.dispose();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	test("rejects a stale bot filter instead of silently opening the global view", async () => {
		const directory = temporaryDirectory("tg-filter-scope-");
		const db = openDb(join(directory, "agent.db"));
		const ipc = new IpcServer(db, join(directory, "daemon.sock"), new Map([["A", "bot A"]]), new Map([["A", 1]]));
		ipc.start();
		const events: TimelineEvent[] = [];
		let resolveDisconnected!: () => void;
		const disconnected = new Promise<void>((resolve) => {
			resolveDisconnected = resolve;
		});
		const client = new TimelineClient(join(directory, "daemon.sock"), "stale", {
			onEvent: (event) => {
				events.push(event);
				if (event.type === "disconnected") resolveDisconnected();
			},
		});
		try {
			expect(await client.connect()).toBe(true);
			await withTimeout(disconnected, 1_000, "stale filter was accepted as a global view");
			expect(events.some((event) => event.type === "append" || event.type === "stats")).toBe(false);
			expect(logLines.some((line) => line.includes('"event":"unknown_filter"'))).toBe(true);
		} finally {
			client.dispose();
			ipc.stop();
			db.close();
		}
	});

	test("keeps a listener silent until hello establishes its bot scope", async () => {
		const directory = temporaryDirectory("tg-filter-handshake-");
		const socketPath = join(directory, "daemon.sock");
		const db = openDb(join(directory, "agent.db"));
		const ipc = new IpcServer(db, socketPath, new Map([["A", "bot A"]]), new Map([["A", 1]]));
		ipc.start();
		const socket = createConnection(socketPath);
		const decoder = new FrameDecoder();
		const frames: ServerMessage[] = [];
		let resolveSnapshot!: () => void;
		let resolveVision!: () => void;
		const snapshot = new Promise<void>((resolve) => {
			resolveSnapshot = resolve;
		});
		const vision = new Promise<void>((resolve) => {
			resolveVision = resolve;
		});
		socket.on("data", (chunk) => {
			for (const frame of decoder.push(chunk) as ServerMessage[]) {
				frames.push(frame);
				if (frame.type === "snapshot") resolveSnapshot();
				if (frame.type === "vision_update") resolveVision();
			}
		});
		await new Promise<void>((resolve, reject) => {
			socket.once("error", reject);
			socket.once("connect", resolve);
		});

		const event: EvtItem = {
			kind: "evt",
			ts: 1,
			evtId: 1,
			botId: "B",
			botName: "bot B",
			evtKind: "assistant_text",
			payload: "{}",
		};
		const usage: UsageRun = {
			id: 1,
			botId: "B",
			ts: 1,
			model: "test",
			epoch: 0,
			contextTokens: 0,
			cacheRead: 0,
			cacheMiss: 0,
			outputTokens: 0,
			cost: 0,
		};
		try {
			ipc.broadcast(event);
			ipc.broadcastUsage(usage);
			ipc.broadcastMediaReady({ fileUniqueId: "shared-photo", mediaPath: "/tmp/shared.png" });
			ipc.broadcastVision({ fileUniqueId: "shared-photo", text: "recognized" });
			socket.write(encodeFrame({ type: "hello", filter: "A" }));
			await withTimeout(snapshot, 1_000, "valid hello did not receive a snapshot");
			expect(frames.map((frame) => frame.type)).toEqual(["snapshot"]);

			frames.length = 0;
			ipc.broadcast(event);
			ipc.broadcastUsage(usage);
			ipc.broadcastVision({ fileUniqueId: "shared-photo", text: "recognized" });
			await withTimeout(vision, 1_000, "shared vision was not broadcast after hello");
			expect(frames.map((frame) => frame.type)).toEqual(["vision_update"]);
		} finally {
			socket.destroy();
			ipc.stop();
			db.close();
		}
	});
});
