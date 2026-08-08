import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type BotConfig } from "../src/config.ts";
import { composeDeployment, composePollers } from "../src/daemon/composition.ts";
import { IpcServer } from "../src/daemon/ipc-server.ts";
import { getBotState } from "../src/db/db.ts";
import { dispatchRoutingDecision, routeMessageDecision, type RoutingRuntime, type RoutingTrigger, type TriggerSource } from "../src/agent/router.ts";
import type { MessageRow } from "../src/agent/serialize.ts";

class FakeRuntime implements RoutingRuntime {
	readonly triggers: Array<{ source: TriggerSource; trigger: RoutingTrigger }> = [];

	constructor(readonly botId: string, readonly sessionKey: string) {}

	trigger(source: TriggerSource, trigger: RoutingTrigger): "started" {
		this.triggers.push({ source, trigger });
		return "started";
	}
}

function makeFixture(count: number): string {
	const dir = mkdtempSync(join(tmpdir(), `platform-${count}-bot-`));
	mkdirSync(join(dir, "personas"));
	const bots = Array.from({ length: count }, (_, index) => {
		const id = String.fromCharCode("A".charCodeAt(0) + index);
		writeFileSync(join(dir, `personas/${id}.md`), `# Persona ${id}\n`);
		return {
			id,
			name: `Persona ${id}`,
			token_env: `platform_${id}_token`,
			persona_path: `personas/${id}.md`,
			routing_p: 0,
		};
	});
	writeFileSync(join(dir, ".env"), [
		"platform_provider_key: provider-test-key",
		"platform_tinyfish_key: tinyfish-test-key",
		...bots.map((bot, index) => `${bot.token_env}: ${index + 1}:telegram-test-token`),
	].join("\n"));
	writeFileSync(join(dir, "bots.config.json"), JSON.stringify({
		group_peer_id: 4402809405,
		provider: "deepseek",
		model: "deepseek-v4-flash",
		reasoning_effort: "medium",
		api_key_env: "platform_provider_key",
		tinyfish_key_env: "platform_tinyfish_key",
		bots,
	}));
	return dir;
}

function snapshot(server: IpcServer, filter?: string): { stats: { bots: Record<string, unknown> } } {
	const frames: unknown[] = [];
	const socket = {
		write(data: Uint8Array): number {
			for (const line of new TextDecoder().decode(data).split("\n")) {
				if (line) frames.push(JSON.parse(line));
			}
			return data.byteLength;
		},
		end() {},
	};
	(server as any).listeners.add(socket);
	(server as any).handleRequest(socket, { type: "hello", ...(filter ? { filter } : {}) });
	return frames[0] as { stats: { bots: Record<string, unknown> } };
}

describe("generic daemon composition (REQ-PLAT-0001)", () => {
	for (const count of [1, 2, 3]) {
		test(`AC2: ${count}-bot config reaches runtime, poller, router, state, and IPC stats boundaries`, async () => {
			const dir = makeFixture(count);
			const db = new Database(":memory:");
			db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
			try {
				const config = loadConfig(dir);
				const ids = config.bots.map((bot) => bot.id);
				const seenIdentities: string[] = [];
				const composition = await composeDeployment(db, config, {
					createApi: (bot: BotConfig) => ({
						botId: bot.id,
						getMe: async () => ({
							id: 10_000 + ids.indexOf(bot.id),
							username: `${bot.id.toLowerCase()}_fixture_bot`,
						}),
					}),
					createRuntime: async (bot): Promise<FakeRuntime> => new FakeRuntime(bot.id, join(config.dataDir, "sessions", bot.id)),
					onIdentity: (bot) => {
						seenIdentities.push(bot.id);
					},
				});

				expect([...composition.botApis.keys()]).toEqual(ids);
				expect([...composition.runtimes.keys()]).toEqual(ids);
				expect(composition.identities.map((identity) => identity.id)).toEqual(ids);
				expect(seenIdentities).toEqual(ids);
				expect(new Set(composition.runtimes.values()).size).toBe(count);
				expect([...composition.runtimes.values()].map((runtime) => runtime.sessionKey)).toEqual(
					ids.map((id) => join(config.dataDir, "sessions", id)),
				);
				for (const [index, id] of ids.entries()) {
					expect(getBotState(db, id, "bot_user_id")).toBe(String(10_000 + index));
					expect(getBotState(db, id, "bot_username")).toBe(`${id.toLowerCase()}_fixture_bot`);
				}

				const pollers = composePollers(db, config, () => {}, composition.replyBotTargets);
				expect(pollers.map((poller) => (poller as any).botId)).toEqual(ids);
				expect(new Set(pollers).size).toBe(count);
				for (const poller of pollers) {
					expect((poller as any).replyBotTargets).toBe(composition.replyBotTargets);
				}

				for (const [index, bot] of config.bots.entries()) {
					db.query(
						"INSERT INTO llm_runs (bot_id, ts, model, epoch, context_tokens, cache_read, cache_miss, output_tokens, cost) VALUES (?, ?, ?, 1, 10, 5, 5, 1, 0)",
					).run(bot.id, index + 1, bot.model);
				}
				const ipc = new IpcServer(db, join(dir, "unused.sock"), composition.botNames, composition.botUserIds);
				expect(Object.keys(snapshot(ipc).stats.bots)).toEqual(ids);
				const lastId = ids.at(-1)!;
				expect(Object.keys(snapshot(ipc, lastId).stats.bots)).toEqual([lastId]);

				const chatId = Number(`-100${config.groupPeerId}`);
				const target = config.bots.at(-1)!;
				db.query(
					`INSERT INTO messages (chat_id, message_id, date, sender_id, display_name, is_bot, text, first_seen_by)
					 VALUES (?, 900, 1754600000, 42, 'Tester', 0, ?, 'fixture')`,
				).run(chatId, `${target.name}, hello`);
				const row = db.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = 900").get(chatId) as MessageRow;
				const decision = routeMessageDecision(db, row, composition.identities, {
					secret: "fixture-secret",
					probs: config.bots.map((bot) => bot.routingP),
				});
				expect(dispatchRoutingDecision(decision, composition.runtimes)).toMatchObject({
					target: target.id,
					reason: "name",
					outcome: "started",
				});
				expect([...composition.runtimes.values()].map((runtime) => runtime.triggers.length)).toEqual(
					ids.map((id) => id === target.id ? 1 : 0),
				);
			} finally {
				db.close();
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});
