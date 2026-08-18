// LiteLLM 代理 provider（https://litellm.mizore.blog/v1）。
// API key 存 Pi auth 存储（~/.pi/agent/auth.json 的 "litellm" 条目），不落仓库。
// 模型 id 用代理认识的完整名 "xai-grokplus/grok-4.6"（请求体 model 字段原样发送），
// 因此配置引用为 litellm/xai-grokplus/grok-4.6:effort。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("litellm", {
		name: "LiteLLM (mizore.blog)",
		baseUrl: "https://litellm.mizore.blog/v1",
		apiKey: "$LITELLM_MIZORE_API_KEY",
		api: "openai-completions",
		models: [
			{
				id: "xai-grokplus/grok-4.6",
				name: "Grok 4.6 (xai-grokplus)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 500_000,
				maxTokens: 500_000,
				thinkingLevelMap: {
					off: null,
					minimal: null,
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: null,
				},
				compat: {
					supportsReasoningEffort: true,
				},
			},
		],
	});
}
