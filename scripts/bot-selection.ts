import type { BotConfig } from "../src/config.ts";

function validIds(bots: readonly Pick<BotConfig, "id">[]): string {
	return bots.map((bot) => bot.id).join(", ");
}

/** Parse the shared, required bot selector used by scripts that act as one configured bot. */
export function selectConfiguredBot<T extends Pick<BotConfig, "id">>(
	bots: readonly T[],
	args: readonly string[],
): T {
	let selected: string | null = null;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--") continue;
		let value: string | undefined;
		if (arg === "--bot") {
			value = args[++index];
			if (!value || value.startsWith("--")) {
				throw new Error(`--bot requires an id; valid bot ids: ${validIds(bots)}`);
			}
		} else if (arg.startsWith("--bot=")) {
			value = arg.slice("--bot=".length);
			if (!value) throw new Error(`--bot requires an id; valid bot ids: ${validIds(bots)}`);
		} else {
			throw new Error(`unknown argument "${arg}"; usage: --bot <id>`);
		}
		if (selected !== null) throw new Error("--bot may be provided only once");
		selected = value;
	}
	if (selected === null) throw new Error(`missing required --bot <id>; valid bot ids: ${validIds(bots)}`);
	const bot = bots.find((candidate) => candidate.id === selected);
	if (!bot) throw new Error(`unknown bot id "${selected}"; valid bot ids: ${validIds(bots)}`);
	return bot;
}
