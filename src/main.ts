// CLI: start | restart | status | stop | attach.

import { DaemonController, createNodeDaemonControlPort, type DaemonControlResult } from "./daemon/control.ts";

const rootDir = process.cwd();
const cmd = process.argv[2];

function report(result: DaemonControlResult): void {
	for (const line of result.lines) (result.ok ? console.log : console.error)(line);
	if (result.logTail) console.error(`recent daemon log (redacted):\n${result.logTail}`);
	if (!result.ok) process.exitCode = 1;
}

const controller = new DaemonController(createNodeDaemonControlPort(rootDir));

switch (cmd) {
	case "start": {
		if (process.argv.includes("--foreground")) {
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
	case "attach": {
		console.error("观察者已迁移为 pi 插件：在项目目录运行 `bun run pi`，然后输入 /tg attach [bot-id]（或 /tg panel / /tg status）。daemon 起停使用 start/restart/status/stop。");
		process.exitCode = 1;
		break;
	}
	default:
		console.error("usage: bun run src/main.ts <start [--foreground] | restart | status | stop | attach>");
		process.exitCode = 1;
}
