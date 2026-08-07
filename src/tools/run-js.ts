// Sandboxed run_js: executes small pure-computation JS in an isolated child process.
// Isolation boundary (docs/requirement.md 三十七):
// - child process gets an EMPTY environment (no secrets) and an isolated tmp cwd
// - code runs inside node:vm with only plain JS globals + console (no process/require/Bun/fs/network)
// - hard timeout, stdout/stderr cap
// Tests: test/runjs.test.ts (must re-run after any change to the sandbox model).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 5000;
const MAX_OUTPUT = 4096;
const MAX_CODE = 16_000;

// Wrapper executed by the child bun: reads code file path from argv, runs it in a vm
// with a minimal context, prints result. __RESULT__ marker separates prints from result.
const WRAPPER = `
import { readFileSync } from "node:fs";
import vm from "node:vm";
const code = readFileSync(process.argv[2], "utf8");
const logs = [];
const sandbox = {
	console: { log: (...a) => logs.push(a.map(String).join(" ")) },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
	const result = vm.runInContext(code, sandbox, { timeout: 3000 });
	for (const l of logs) process.stdout.write(l + "\\n");
	process.stdout.write("__RESULT__" + (result === undefined ? "undefined" : typeof result === "string" ? result : JSON.stringify(result)));
} catch (err) {
	for (const l of logs) process.stdout.write(l + "\\n");
	process.stderr.write(String(err && err.message ? err.message : err));
	process.exit(2);
}
`;

export interface RunJsResult {
	ok: boolean;
	output: string; // console output + final expression value (or error message)
	durationMs: number;
}

export async function runJs(code: string): Promise<RunJsResult> {
	if (code.length > MAX_CODE) return { ok: false, output: `code too large (${code.length} > ${MAX_CODE})`, durationMs: 0 };
	const started = Date.now();
	const dir = mkdtempSync(join(tmpdir(), "runjs-"));
	try {
		writeFileSync(join(dir, "wrapper.mjs"), WRAPPER);
		writeFileSync(join(dir, "code.js"), code);
		return await new Promise<RunJsResult>((resolve) => {
			const child = spawn("bun", [join(dir, "wrapper.mjs"), join(dir, "code.js")], {
				cwd: dir,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, // empty except PATH: no secrets
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			let err = "";
			const cap = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n...(truncated)` : s);
			child.stdout.on("data", (d: Buffer) => { out = cap(out + d.toString()); });
			child.stderr.on("data", (d: Buffer) => { err = cap(err + d.toString()); });
			const killer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve({ ok: false, output: cap(out + `\n(timeout after ${TIMEOUT_MS}ms)`), durationMs: Date.now() - started });
			}, TIMEOUT_MS);
			child.on("close", (codeNum) => {
				clearTimeout(killer);
				const durationMs = Date.now() - started;
				if (codeNum === 0) {
					resolve({ ok: true, output: cap(out), durationMs });
				} else {
					resolve({ ok: false, output: cap(out + (err ? `\n${err}` : "")), durationMs });
				}
			});
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
