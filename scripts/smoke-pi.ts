// Smoke test: Bun runtime × Pi SDK × DeepSeek provider.
// Creates a headless AgentSession, sends one prompt, prints reply + usage.
// Usage: bun run scripts/smoke-pi.ts
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

function loadEnv(path: string): void {
	const text = require("node:fs").readFileSync(path, "utf8") as string;
	for (const line of text.split("\n")) {
		const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
		if (m) process.env[m[1]] = m[2].trim();
	}
}

loadEnv(new URL("../.env", import.meta.url).pathname);
process.env.DEEPSEEK_API_KEY = process.env.deepseek_api_key;

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("deepseek", process.env.deepseek_model ?? "deepseek-v4-flash");
if (!model) throw new Error("deepseek model not found in catalog");

const loader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: `${process.env.HOME}/.pi/agent`,
	systemPrompt: "You are a concise assistant. Answer in one short sentence.",
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noContextFiles: true,
});
await loader.reload();

const { session } = await createAgentSession({
	cwd: process.cwd(),
	model,
	thinkingLevel: "medium",
	modelRuntime,
	sessionManager: SessionManager.inMemory(process.cwd()),
	settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
	resourceLoader: loader,
	noTools: "all",
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

await session.prompt("What is 2+2? Answer with just the number.");
console.log("TEXT:", text.trim());
console.log("THINKING (first 120):", thinking.slice(0, 120));
console.log("USAGE:", JSON.stringify(usage));
await session.dispose();
console.log("SMOKE OK");
process.exit(0);
