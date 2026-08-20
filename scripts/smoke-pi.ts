// Smoke test: Bun runtime × omp SDK × one configured provider/model.
// Creates a headless AgentSession, sends one prompt, prints reply + usage.
// Usage: bun run scripts/smoke-pi.ts --bot <id>
import { AgentRegistry, createAgentSession, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import { createSharedModelRuntime } from "../src/agent/model-runtime.ts";
import { EFFORT_BY_THINKING_LEVEL } from "../src/agent/model-ref.ts";
import { selectConfiguredBot } from "./bot-selection.ts";

const config = loadConfig(process.cwd());
const bot = selectConfiguredBot(config.bots, process.argv.slice(2));
const modelRegistry = await createSharedModelRuntime([bot]);
const model = modelRegistry.find(bot.provider, bot.model);
if (!model) throw new Error(`model not found: ${bot.provider}/${bot.model}`);

const { session } = await createAgentSession({
	cwd: process.cwd(),
	model,
	thinkingLevel: bot.reasoningEffort === "off" ? "off" : EFFORT_BY_THINKING_LEVEL[bot.reasoningEffort],
	modelRegistry,
	sessionManager: SessionManager.inMemory(process.cwd()),
	settings: Settings.isolated({ "compaction.enabled": false }),
	disableExtensionDiscovery: true,
	skills: [],
	rules: [],
	contextFiles: [],
	promptTemplates: [],
	slashCommands: [],
	toolNames: [],
	restrictToolNames: true,
	enableMCP: false,
	enableLsp: false,
	enableIrc: false,
	hasUI: false,
	autoApprove: true,
	agentRegistry: new AgentRegistry(),
	agentId: "telegram-smoke",
	agentDisplayName: "telegram-smoke",
});

let thinking = "";
let text = "";
let usage: unknown = null;
session.subscribe((e) => {
	if (e.type === "message_update") {
		const ev = e.assistantMessageEvent;
		if (ev.type === "thinking_delta") thinking += ev.delta;
		if (ev.type === "text_delta") text += ev.delta;
	}
	if (e.type === "message_end" && e.message.role === "assistant") {
		usage = e.message.usage;
	}
});

await session.agent.prompt("What is 2+2? Answer with just the number.");
console.log("TEXT:", text.trim());
console.log("THINKING (first 120):", thinking.slice(0, 120));
console.log("USAGE:", JSON.stringify(usage));
await session.dispose();
console.log("SMOKE OK");
process.exit(0);
