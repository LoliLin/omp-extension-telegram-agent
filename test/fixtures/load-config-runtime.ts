import { loadConfig } from "../../src/config.ts";

const config = loadConfig(process.argv[2] ?? "");
process.stdout.write(JSON.stringify({
	groupPeerId: config.groupPeerId,
	telegramAdmins: config.telegramAdmins,
	bots: config.bots.map((bot) => ({
		id: bot.id,
		name: bot.name,
		provider: bot.provider,
		model: bot.model,
		apiKeyEnv: bot.apiKeyEnv,
		routingP: bot.routingP,
		samplingCooldownMs: bot.samplingCooldownMs,
		tools: bot.tools,
	})),
}));
