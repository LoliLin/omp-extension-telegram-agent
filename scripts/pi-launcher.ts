import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const PI_CLI_RELATIVE_PATH = "node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

export class PiBootstrapError extends Error {}

/** Install the exact lockfile only when the project-local Pi CLI is absent. */
export async function ensurePiDependencies(rootDir: string): Promise<boolean> {
	const cliPath = join(rootDir, PI_CLI_RELATIVE_PATH);
	if (existsSync(cliPath)) return false;

	const status = await run([process.execPath, "install", "--frozen-lockfile"], rootDir);
	if (status !== 0) {
		throw new PiBootstrapError(
			`Dependency bootstrap failed with exit code ${status}. Run: bun install --frozen-lockfile`,
		);
	}
	if (!existsSync(cliPath)) {
		throw new PiBootstrapError(`Dependency bootstrap completed but ${PI_CLI_RELATIVE_PATH} is missing.`);
	}
	return true;
}

/** Bootstrap once, then run the version pinned by this project's lockfile under Bun. */
export async function launchProjectPi(rootDir: string, args: readonly string[]): Promise<number> {
	await ensurePiDependencies(rootDir);
	return run([process.execPath, join(rootDir, PI_CLI_RELATIVE_PATH), ...args], rootDir);
}

async function run(command: readonly string[], cwd: string): Promise<number> {
	const child = Bun.spawn([...command], {
		cwd,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return await child.exited;
}

if (import.meta.main) {
	const rootDir = resolve(import.meta.dir, "..");
	try {
		process.exitCode = await launchProjectPi(rootDir, process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Unable to start project Pi.");
		process.exitCode = 1;
	}
}
