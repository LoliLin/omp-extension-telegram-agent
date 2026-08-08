import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	MDBOOK_VERSION,
	checkGeneratedHtmlLinks,
	checkMarkdownLinks,
	checkRepositoryMarkdownLinks,
} from "../scripts/docs-site.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "docs-site-test-"));
	temporaryDirectories.push(path);
	return path;
}

describe("bilingual documentation publishing (REQ-ONBOARD-0001 T13f)", () => {
	test("tracked README and book Markdown links resolve", () => {
		const report = checkRepositoryMarkdownLinks(process.cwd());
		expect(report.issues).toEqual([]);
		expect(report.files).toBe(18);
		expect(report.links).toBeGreaterThan(40);
	});

	test("Markdown checker reports a missing local target without following external URLs", () => {
		const root = temporaryDirectory();
		const page = join(root, "README.md");
		writeFileSync(page, "[ok](https://example.invalid) [missing](missing.md)\n");
		const report = checkMarkdownLinks(root, [page]);
		expect(report.links).toBe(2);
		expect(report.issues).toEqual([
			{ file: "README.md", href: "missing.md", reason: "target does not exist" },
		]);
	});

	test("generated checker resolves directory links and validates fragments", () => {
		const site = temporaryDirectory();
		mkdirSync(join(site, "en"));
		writeFileSync(join(site, "index.html"), '<a href="./en/">English</a>');
		writeFileSync(join(site, "en/index.html"), '<h1 id="start">Start</h1><a href="#missing">Bad</a>');
		const report = checkGeneratedHtmlLinks(site);
		expect(report.issues).toEqual([
			{ file: "en/index.html", href: "#missing", reason: "missing fragment #missing" },
		]);
	});

	test("book configs and workflow pin the documented toolchain and least privilege", () => {
		for (const language of ["zh", "en"]) {
			const config = readFileSync(resolve(`docs/user-guide/${language}/book.toml`), "utf8");
			expect(config).toContain(`language = "${language === "zh" ? "zh-CN" : "en"}"`);
			expect(config).toContain(`site-url = "/pi-extension-telegram-agent/${language}/"`);
			expect(config).toContain("create-missing = false");
		}

		const workflow = readFileSync(resolve(".github/workflows/docs-pages.yml"), "utf8");
		expect(MDBOOK_VERSION).toBe("0.5.4");
		expect(workflow).toContain("permissions:\n  contents: read");
		expect(workflow.match(/pages: write/g)).toHaveLength(1);
		expect(workflow.match(/id-token: write/g)).toHaveLength(1);
		expect(workflow).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
		expect(workflow).toContain("cancel-in-progress: true");
		expect(workflow).not.toMatch(/\bsecrets\./);
		for (const pin of [
			"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
			"oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
			"actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9",
			"actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d",
			"actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128",
		]) expect(workflow).toContain(pin);
	});
});

describe("minimal design and one-directory deployment boundary (REQ-DOC-0002)", () => {
	test("keeps the authoritative philosophy and agent checklist linked", () => {
		const agents = readFileSync(resolve("AGENTS.md"), "utf8");
		const project = readFileSync(resolve("docs/project.md"), "utf8");
		const development = readFileSync(resolve("docs/engineering/development-guide.md"), "utf8");
		const maintainer = readFileSync(resolve("docs/maintainers/guide.md"), "utf8");

		expect(agents).toContain("最少机制");
		expect(agents).toContain("docs/project.md");
		expect(agents).toContain("docs/engineering/development-guide.md");
		expect(project).toContain("## 项目哲学：最少机制，完整边界");
		for (const phrase of ["确定性代码", "cached prefix", "有界", "Pi runtime", "同目录多群"]) {
			expect(project).toContain(phrase);
		}
		expect(development).toContain("### 方案最小化检查");
		for (const phrase of ["少一层抽象", "复用 Pi 原生", "一次模型调用", "一个动态字段", "不得扩成同目录多群"]) {
			expect(development).toContain(phrase);
		}
		expect(maintainer).toContain("方案最小化检查");
	});

	test("explains the same four isolation classes in both user guides", () => {
		const zh = readFileSync(resolve("docs/user-guide/zh/src/operations.md"), "utf8");
		const en = readFileSync(resolve("docs/user-guide/en/src/operations.md"), "utf8");
		for (const phrase of ["group_peer_id", "canonical history", "agent session", "update offset", "control lock", "Unix socket", "模型context"]) {
			expect(zh).toContain(phrase);
		}
		for (const phrase of ["group_peer_id", "canonical SQLite history", "agent sessions", "update offset", "control lock", "Unix socket", "model context"]) {
			expect(en).toContain(phrase);
		}
		expect(readFileSync(resolve("README.md"), "utf8")).toContain("operations.md#为什么必须隔离工作目录");
		expect(readFileSync(resolve("README.en.md"), "utf8")).toContain("operations.md#why-working-directories-must-be-isolated");
	});

	test("retains all six bounded cost mechanisms in both languages", () => {
		for (const language of ["zh", "en"]) {
			const cost = readFileSync(resolve(`docs/user-guide/${language}/src/design-cost.md`), "utf8");
			expect(cost.match(/^## [1-6]\. /gm)).toHaveLength(6);
			expect(cost).toMatch(/不承诺固定节省百分比|promises no fixed savings percentage/);
			expect(cost).toMatch(/一个动态字段|dynamic field/);
		}
	});
});
