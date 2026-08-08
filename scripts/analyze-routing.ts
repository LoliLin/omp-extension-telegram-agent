#!/usr/bin/env bun

import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
	analyzeRouting,
	formatRoutingAudit,
	openRoutingAuditDatabase,
	readRoutingAuditLog,
	resolveRoutingAuditInput,
} from "../src/agent/routing-audit.ts";

function usage(): string {
	return "Usage: bun run scripts/analyze-routing.ts [--no-log | <daemon-log-path>]\n";
}

export function main(args = process.argv.slice(2), rootDir = process.cwd()): number {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		process.stdout.write(usage());
		return 0;
	}
	if (args.length > 1) {
		process.stderr.write(usage());
		return 2;
	}
	let db: ReturnType<typeof openRoutingAuditDatabase> | null = null;
	try {
		const config = loadConfig(rootDir);
		db = openRoutingAuditDatabase(config.dbPath);
		const log = args[0] === "--no-log"
			? null
			: readRoutingAuditLog(args[0] ? resolve(rootDir, args[0]) : join(config.dataDir, "daemon.log"));
		const input = resolveRoutingAuditInput(db, config, log);
		process.stdout.write(formatRoutingAudit(analyzeRouting(db, input)));
		return 0;
	} catch {
		process.stderr.write("Routing audit unavailable: invalid local configuration or state.\n");
		return 1;
	} finally {
		db?.close();
	}
}

if (import.meta.main) process.exitCode = main();
