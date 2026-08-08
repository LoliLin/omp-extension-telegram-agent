import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	ensurePiDependencies,
	launchProjectPi,
	PI_CLI_RELATIVE_PATH,
	type PiLauncherIO,
} from "../scripts/pi-launcher.ts";

interface FakeLauncher extends PiLauncherIO {
	commands: string[][];
	installed: boolean;
}

function makeLauncher(options: { installed?: boolean; installStatus?: number; installCreatesCli?: boolean } = {}): FakeLauncher {
	return {
		commands: [],
		installed: options.installed ?? false,
		exists(path) {
			return this.installed && path.endsWith(PI_CLI_RELATIVE_PATH);
		},
		async run(command) {
			this.commands.push([...command]);
			if (command[1] === "install") {
				if (options.installCreatesCli !== false) this.installed = true;
				return options.installStatus ?? 0;
			}
			return 0;
		},
	};
}

describe("portable Pi launcher", () => {
	test("a fresh checkout installs the frozen lock before starting project Pi", async () => {
		const io = makeLauncher();
		const rootDir = "/isolated/pi-extension-telegram-agent";

		expect(await launchProjectPi(rootDir, ["--version"], io)).toBe(0);
		expect(io.commands).toEqual([
			[process.execPath, "install", "--frozen-lockfile"],
			[process.execPath, join(rootDir, PI_CLI_RELATIVE_PATH), "--version"],
		]);
	});

	test("an installed checkout starts without another install", async () => {
		const io = makeLauncher({ installed: true });
		await launchProjectPi("/repo", ["--print"], io);
		expect(io.commands).toEqual([[process.execPath, join("/repo", PI_CLI_RELATIVE_PATH), "--print"]]);
	});

	test("bootstrap failures stop before Pi and point to the reproducible command", async () => {
		const io = makeLauncher({ installStatus: 17 });
		expect(ensurePiDependencies("/repo", io)).rejects.toThrow("bun install --frozen-lockfile");
		expect(io.commands).toHaveLength(1);
	});

	test("a successful install that lacks the pinned CLI fails closed", async () => {
		const io = makeLauncher({ installCreatesCli: false });
		expect(ensurePiDependencies("/repo", io)).rejects.toThrow(PI_CLI_RELATIVE_PATH);
		expect(io.commands).toHaveLength(1);
	});
});
