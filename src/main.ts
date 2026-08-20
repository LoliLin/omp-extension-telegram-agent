// CLI: start | restart | status | stop.

import { join } from "node:path";
import { DaemonController, type DaemonControlResult } from "./daemon/control.ts";
import { loadConfig, parseEnvFile } from "./config.ts";
import { inspectVideoTranscoder, videoTranscoderAdvisory } from "./media/video-frames.ts";

const rootDir = process.cwd();

// Telegram is unreachable without a proxy in many networks. Bun's fetch honors
// the standard proxy environment variables, so surface a proxy declared in the
// project .env (e.g. `https_proxy: http://127.0.0.1:7890`) to the daemon and
// its children without requiring a shell-level environment change.
for (const key of ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const) {
	if (process.env[key] !== undefined) continue;
	try {
		const value = parseEnvFile(join(rootDir, ".env"))[key];
		if (value) process.env[key] = value;
	} catch {
		// A missing/unreadable .env is a config error reported by loadConfig below.
	}
}

const cmd = process.argv[2];

function report(result: DaemonControlResult): void {
	for (const line of result.lines) (result.ok ? console.log : console.error)(line);
	if (result.logTail) console.error(`recent daemon log (redacted):\n${result.logTail}`);
	if (result.ok && cmd !== "stop") reportAdvisory();
	if (!result.ok) process.exitCode = 1;
}

function reportAdvisory(): void {
	try {
		const config = loadConfig(rootDir);
		const advisory = videoTranscoderAdvisory(config.vision.enabled, inspectVideoTranscoder());
		if (advisory) console.warn(advisory);
	} catch {
		// Daemon startup owns config failures; an optional capability hint must never mask or block it.
	}
}

const controller = new DaemonController(rootDir, join(import.meta.dir, "daemon", "index.ts"));

switch (cmd) {
	case "start": {
		if (process.argv.includes("--foreground")) {
			reportAdvisory();
			await import("./daemon/index.ts");
			break;
		}
		report(await controller.start());
		break;
	}
	case "restart": {
		report(await controller.restart());
		break;
	}
	case "status": {
		report(controller.status());
		break;
	}
	case "stop": {
		report(controller.stop());
		break;
	}
	default:
		console.error("usage: bun run src/main.ts <start [--foreground] | restart | status | stop>");
		process.exitCode = 1;
}
