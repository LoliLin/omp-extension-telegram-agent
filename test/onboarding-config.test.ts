import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
	mergeEnvSource,
	nodeConfigFileOps,
	OnboardingValidationError,
	readExistingConfigSource,
	replaceExistingConfigSource,
	validateEditedConfigSource,
	validateExistingDeployment,
	writeFirstRunDeployment,
	type FirstRunDraft,
} from "../src/onboarding/config-core.ts";

const PROVIDER_SECRET = "NOT_A_REAL_PROVIDER_KEY_FOR_TESTS";
const TELEGRAM_SECRET = "123456:THIS_IS_A_TEST_TOKEN_NOT_VALID";

function draft(overrides: Partial<FirstRunDraft> = {}): FirstRunDraft {
	const base: FirstRunDraft = {
		groupPeerId: "-1001234567890",
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKeyEnv: "llm_api_key",
		providerApiKey: PROVIDER_SECRET,
		bot: {
			id: "friend",
			name: "Mochi",
			tokenEnv: "telegram_bot_token",
			token: TELEGRAM_SECRET,
			personaText: "# Test companion\n\nA generic test-only persona.",
		},
	};
	return {
		...base,
		...overrides,
		bot: { ...base.bot, ...(overrides.bot ?? {}) },
	};
}

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "tg-onboarding-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src/config-schema.ts"), readFileSync("src/config-schema.ts", "utf8"));
	return root;
}

function clean(root: string): void {
	rmSync(root, { recursive: true, force: true });
}

describe("atomic onboarding config core (REQ-ONBOARD-0001)", () => {
	test("AC4: fresh write is private, secret-free in config, and accepted by final loadConfig", () => {
		const root = makeRoot();
		const events: string[] = [];
		try {
			const result = writeFirstRunDeployment(root, draft(), {
				nonce: "fresh",
				onEvent: (event) => events.push(JSON.stringify(event)),
			});
			expect(result.backupPaths).toEqual([]);
			expect(result.summary).toEqual({
				configPath: "telegram.config.ts",
				groupPeerId: 1234567890,
				bots: [{ id: "friend", name: "Mochi", provider: "deepseek", model: "deepseek-v4-flash" }],
			});
			const configSource = readFileSync(join(root, "telegram.config.ts"), "utf8");
			expect(configSource).toContain('api_key_env: "llm_api_key"');
			expect(configSource).toContain('token_env: "telegram_bot_token"');
			expect(configSource).not.toContain(PROVIDER_SECRET);
			expect(configSource).not.toContain(TELEGRAM_SECRET);
			expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);
			const loaded = loadConfig(root);
			expect(loaded.bots[0]!.tools.search).toBe(false);
			expect(loaded.tinyfishApiKey).toBe("");
			expect(events.join("\n")).not.toContain(PROVIDER_SECRET);
			expect(events.join("\n")).not.toContain(TELEGRAM_SECRET);
		} finally {
			clean(root);
		}
	});

	test("AC4: create mode denies existing files without changing a byte", () => {
		const root = makeRoot();
		const original = "existing_key: preserve-exactly\n";
		writeFileSync(join(root, ".env"), original);
		try {
			expect(() => writeFirstRunDeployment(root, draft(), { nonce: "deny" })).toThrow(/existing files were preserved: \.env/);
			expect(readFileSync(join(root, ".env"), "utf8")).toBe(original);
			expect(existsSync(join(root, "telegram.config.ts"))).toBe(false);
			expect(existsSync(join(root, "personas/friend.local.md"))).toBe(false);
		} finally {
			clean(root);
		}
	});

	test("AC4: invalid peer, token, provider, model, and persona fail before filesystem writes", () => {
		const cases: Array<[string, FirstRunDraft]> = [
			["group_peer_id", draft({ groupPeerId: "not-a-peer" })],
			["bot.token", draft({ bot: { ...draft().bot, token: "invalid" } })],
			["provider", draft({ provider: "bad provider!" })],
			["model", draft({ model: "" })],
			["bot.persona", draft({ bot: { ...draft().bot, personaText: "  " } })],
		];
		for (const [field, value] of cases) {
			const root = makeRoot();
			try {
				let error: unknown;
				try {
					writeFirstRunDeployment(root, value, { nonce: "invalid" });
				} catch (caught) {
					error = caught;
				}
				expect(error).toBeInstanceOf(OnboardingValidationError);
				expect((error as OnboardingValidationError).fields).toContain(field);
				expect(existsSync(join(root, ".env"))).toBe(false);
				expect(existsSync(join(root, "telegram.config.ts"))).toBe(false);
			} finally {
				clean(root);
			}
		}
	});

	test("AC4: a rename failure rolls back every installed target and temporary file", () => {
		const root = makeRoot();
		let targetRenames = 0;
		const failingOps = {
			...nodeConfigFileOps,
			rename(from: string, to: string) {
				if (from.includes(".tmp-")) {
					targetRenames++;
					if (targetRenames === 2) throw new Error("fixture rename failure");
				}
				nodeConfigFileOps.rename(from, to);
			},
		};
		try {
			expect(() => writeFirstRunDeployment(root, draft(), { nonce: "rename", fileOps: failingOps })).toThrow(/original files were restored/);
			for (const path of [".env", "telegram.config.ts", "personas/friend.local.md"]) {
				expect(existsSync(join(root, path))).toBe(false);
			}
			const names = readdirSync(root, { recursive: true }).map(String);
			expect(names.some((name) => name.includes(".tmp-rename"))).toBe(false);
		} finally {
			clean(root);
		}
	});

	test("AC4: confirmed full replacement keeps backups and merges unrelated env entries", () => {
		const root = makeRoot();
		try {
			writeFirstRunDeployment(root, draft(), { nonce: "initial" });
			const envPath = join(root, ".env");
			writeFileSync(envPath, `${readFileSync(envPath, "utf8")}unrelated_local_key: keep-me\n`);
			const previousConfig = readFileSync(join(root, "telegram.config.ts"), "utf8");
			const replacement = draft({
				providerApiKey: "NOT_A_REAL_REPLACEMENT_PROVIDER_KEY",
				bot: {
					...draft().bot,
					name: "Nori",
					token: "654321:ANOTHER_TEST_TOKEN_NEVER_VALID",
					personaText: "# Replacement fixture\n",
				},
			});
			const result = writeFirstRunDeployment(root, replacement, {
				mode: "backup-replace",
				nonce: "replace",
			});
			expect(result.backupPaths.sort()).toEqual([
				".env.bak-replace",
				"personas/friend.local.md.bak-replace",
				"telegram.config.ts.bak-replace",
			].sort());
			expect(readFileSync(join(root, "telegram.config.ts.bak-replace"), "utf8")).toBe(previousConfig);
			const env = readFileSync(envPath, "utf8");
			expect(env).toContain("unrelated_local_key: keep-me");
			expect(env.match(/^llm_api_key:/gm)).toHaveLength(1);
			expect(loadConfig(root).bots[0]!.name).toBe("Nori");
		} finally {
			clean(root);
		}
	});

	test("AC4: validate existing and editor round-trip preserve source until confirmed replacement", () => {
		const root = makeRoot();
		try {
			writeFirstRunDeployment(root, draft(), { nonce: "editor-base" });
			const existing = readExistingConfigSource(root);
			const original = existing.source;
			expect(validateExistingDeployment(root).bots[0]!.name).toBe("Mochi");
			expect(validateEditedConfigSource(root, existing.path, original, { nonce: "validate" }).bots[0]!.name).toBe("Mochi");
			expect(readFileSync(existing.path, "utf8")).toBe(original);

			const edited = original.replace('name: "Mochi"', 'name: "Edited"') + "// editor round-trip\n";
			expect(() => replaceExistingConfigSource(root, existing.path, edited, {
				confirmed: false,
				nonce: "edit",
			})).toThrow(/not confirmed/);
			expect(readFileSync(existing.path, "utf8")).toBe(original);

			const result = replaceExistingConfigSource(root, existing.path, edited, {
				confirmed: true,
				nonce: "edit",
			});
			expect(result.backupPath).toBe("telegram.config.ts.bak-edit");
			expect(readFileSync(join(root, result.backupPath), "utf8")).toBe(original);
			expect(readFileSync(existing.path, "utf8")).toBe(edited);
			expect(loadConfig(root).bots[0]!.name).toBe("Edited");
		} finally {
			clean(root);
		}
	});

	test("env merge replaces duplicate managed keys once and preserves unrelated bytes", () => {
		expect(mergeEnvSource(
			"# comment\nmanaged: old\nunrelated: keep\nmanaged: stale\n",
			{ managed: "new", added: "value" },
		)).toBe("# comment\nmanaged: new\nunrelated: keep\n\nadded: value\n");
	});
});
