// Sandboxed run_js: executes small pure-computation JS in an isolated child process.
// Threat model: docs/architecture.md "run_js sandbox 威胁模型"（REQ-SEC-0001）。
// Isolation layers:
// - child process (spawned via process.execPath, --smol) gets an EMPTY environment
//   (no secrets) and an isolated tmp cwd
// - code runs in a node:vm context built from Object.create(null) with
//   codeGeneration disabled: no host-realm object/function ever enters the context,
//   so the classic console.log.constructor / this.constructor.constructor escapes
//   have nothing to grab; eval/new Function inside user code is disabled too
// - console/logs are bootstrapped INSIDE the context; results cross the realm
//   boundary only as strings produced by JSON.stringify inside the context
//   (primitives crossing realms are safe; object references never cross)
// - vm timeout only bounds SYNCHRONOUS code; async microtask blowups and unsettled
//   promises are bounded by the parent-side SIGKILL at TIMEOUT_MS
// - hard timeout, stdout/stderr cap
// Tests: test/runjs.test.ts (must re-run after any change to the sandbox model).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 5000; // parent-side SIGKILL backstop (covers async blowups)
const VM_TIMEOUT_MS = 3000; // vm timeout; only bounds synchronous execution
const MAX_OUTPUT = 4096;
const MAX_CODE = 16_000;
const MAX_RAW = 16_384; // raw child stdout bound; wrapper caps its payload well below this

// Wrapper executed by the child bun. Protocol: exactly one JSON line on stdout —
// { ok, logs: string[], result?: string, error?: string } — no __RESULT__ marker,
// so user prints can never collide with the framing.
const WRAPPER = `
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(process.argv[2], "utf8");
const started = Date.now();

const sandbox = Object.create(null);
const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

// Bootstrap inside the context realm: console collects into an in-context array;
// __safe formats any value to a string without involving host-realm functions.
vm.runInContext(\`
  const __logs = [];
  let __logsLen = 0;
  const __MAX = 4096;
  globalThis.console = {
    log: (...a) => {
      if (__logsLen >= __MAX) return;
      const line = a.map(String).join(" ");
      __logs.push(line);
      __logsLen += line.length + 1;
    },
  };
  globalThis.__safe = (v) => {
    if (v === undefined) return "undefined";
    if (typeof v === "string") return v;
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; }
    catch { return String(v); }
  };
\`, ctx);

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

try {
  // The completion value may be a context-realm object: hand it straight back
  // into the context. The host never invokes its methods and never passes a
  // host value into the context, so no capability crosses realms.
  sandbox.__v = vm.runInContext(code, ctx, { timeout: ${VM_TIMEOUT_MS} });
  const isThenable = vm.runInContext(
    "__v !== null && (typeof __v === 'object' || typeof __v === 'function') && typeof __v.then === 'function'",
    ctx,
  );
  if (isThenable) {
    // Callbacks are created inside the context: no host function crosses realms.
    vm.runInContext(
      "__settled = null; Promise.resolve(__v).then(" +
        "(r) => { __settled = { ok: true, s: __safe(r) }; }," +
        "(e) => { __settled = { ok: false, s: String(e && e.message ? e.message : e) }; });",
      ctx,
    );
    // Bounded wait; the parent-side SIGKILL is the ultimate backstop.
    const deadline = started + ${TIMEOUT_MS - 1000};
    let settled = null;
    while (Date.now() < deadline) {
      const s = vm.runInContext("__settled === null ? null : JSON.stringify(__settled)", ctx);
      if (s !== null) { settled = JSON.parse(s); break; }
      await new Promise((r) => setTimeout(r, 5));
    }
    const logs = JSON.parse(vm.runInContext("JSON.stringify(__logs)", ctx));
    if (settled === null) emit({ ok: false, logs, error: "promise did not settle within time limit" });
    else if (settled.ok) emit({ ok: true, logs, result: settled.s.slice(0, 4096) });
    else emit({ ok: false, logs, error: settled.s });
  } else {
    const result = vm.runInContext("__safe(__v)", ctx);
    const logs = JSON.parse(vm.runInContext("JSON.stringify(__logs)", ctx));
    emit({ ok: true, logs, result: result.slice(0, 4096) });
  }
} catch (err) {
  // err is a context-realm object; stringify it inside the context.
  sandbox.__err = err;
  const message = vm.runInContext("String(__err && __err.message ? __err.message : __err)", ctx);
  const logs = JSON.parse(vm.runInContext("JSON.stringify(__logs)", ctx));
  emit({ ok: false, logs, error: message });
}
`;

export interface RunJsResult {
	ok: boolean;
	output: string; // console output + final expression value (or error message)
	durationMs: number;
}

export async function runJs(code: string, execPath: string = process.execPath): Promise<RunJsResult> {
	if (code.length > MAX_CODE)
		return { ok: false, output: `code too large (${code.length} > ${MAX_CODE})`, durationMs: 0 };
	const started = Date.now();
	const dir = mkdtempSync(join(tmpdir(), "runjs-"));
	try {
		writeFileSync(join(dir, "wrapper.mjs"), WRAPPER);
		writeFileSync(join(dir, "code.js"), code);
		return await new Promise<RunJsResult>((resolve) => {
			const child = spawn(execPath, ["--smol", join(dir, "wrapper.mjs"), join(dir, "code.js")], {
				cwd: dir,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, // empty except PATH: no secrets
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			let err = "";
			const cap = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n...(truncated)` : s);
			child.stdout.on("data", (d: Buffer) => {
				out = cap(out + d.toString(), MAX_RAW);
			});
			child.stderr.on("data", (d: Buffer) => {
				err = cap(err + d.toString(), MAX_OUTPUT);
			});
			const killer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve({
					ok: false,
					output: cap(out + `\n(timeout after ${TIMEOUT_MS}ms)`, MAX_OUTPUT),
					durationMs: Date.now() - started,
				});
			}, TIMEOUT_MS);
			child.on("error", (spawnErr) => {
				// e.g. ENOENT: interpreter missing — structured error, never uncaught
				clearTimeout(killer);
				resolve({
					ok: false,
					output: `failed to spawn sandbox interpreter: ${spawnErr.message}`,
					durationMs: Date.now() - started,
				});
			});
			child.on("close", (codeNum) => {
				clearTimeout(killer);
				const durationMs = Date.now() - started;
				try {
					const msg = JSON.parse(out.trim()) as { ok: boolean; logs?: string[]; result?: string; error?: string };
					const logs = (msg.logs ?? []).join("\n");
					const body = msg.ok
						? [logs, msg.result ?? ""].filter(Boolean).join("\n")
						: [logs, msg.error ?? "unknown error"].filter(Boolean).join("\n");
					resolve({ ok: Boolean(msg.ok), output: cap(body, MAX_OUTPUT), durationMs });
				} catch {
					// wrapper died before emitting its JSON line (killed, crashed, ...)
					if (codeNum === 0) {
						resolve({ ok: true, output: cap(out, MAX_OUTPUT), durationMs });
					} else {
						resolve({
							ok: false,
							output: cap(out + (err ? `\n${err}` : "") || "sandbox failed", MAX_OUTPUT),
							durationMs,
						});
					}
				}
			});
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
