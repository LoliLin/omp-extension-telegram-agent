// TinyFish search tool client. Result is trimmed to a small, stable shape:
// title / url / short snippet, capped count — search should answer questions,
// not dump web pages into context (docs/requirement.md 三十六).

const SEARCH_URL = "https://api.search.tinyfish.ai";
const MAX_RESULTS = 5;
const MAX_SNIPPET = 200;

export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

export async function tinyFishSearch(apiKey: string, query: string): Promise<SearchHit[]> {
	const res = await fetch(`${SEARCH_URL}?query=${encodeURIComponent(query)}&num_results=${MAX_RESULTS}`, {
		headers: { "X-API-Key": apiKey },
	});
	if (!res.ok) throw new Error(`search failed: http ${res.status}`);
	const body = (await res.json()) as {
		results?: { title?: string; url?: string; snippet?: string }[];
	};
	return (body.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
		title: (r.title ?? "").slice(0, 120),
		url: r.url ?? "",
		snippet: (r.snippet ?? "").replace(/\s+/g, " ").slice(0, MAX_SNIPPET),
	}));
}

export function formatSearchResults(hits: SearchHit[]): string {
	if (hits.length === 0) return "no results";
	return hits.map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`).join("\n\n");
}
