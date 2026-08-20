/**
 * waywiser-*web — web_search + web_extract.
 * web_search: prefers the `vsearch` CLI (Tavily-backed, available in this
 * environment); falls back to a DuckDuckGo HTML scrape with zero dependencies.
 * web_extract: fetch + HTML→text (dependency-free).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

function runVsearch(
	args: string[],
	opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; output: string; error?: string }> {
	return new Promise((resolve) => {
		let settled = false;
		const child = spawn("vsearch", args, { stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			resolve({ ok: false, output: "", error: `vsearch timed out after ${opts.timeoutMs ?? 30_000}ms` });
		}, opts.timeoutMs ?? 30_000);
		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			resolve({ ok: false, output: "", error: "aborted" });
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		let out = "";
		let errOut = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (errOut += d));
		child.on("error", (e) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok: false, output: "", error: String(e) });
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (code === 0) resolve({ ok: true, output: out });
			else resolve({ ok: false, output: out + errOut, error: `exit ${code}` });
		});
	});
}

async function ddgSearch(query: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string; error?: string }> {
	try {
		const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
		const res = await fetch(url, {
			signal,
			headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) WaywiserAgent/0.1" },
		});
		if (!res.ok) return { ok: false, output: "", error: `HTTP ${res.status}` };
		const html = await res.text();
		const results: string[] = [];
		const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
		for (let m = re.exec(html); m && results.length < 8; m = re.exec(html)) {
			let href = m[1];
			// ddg html links are redirect wrappers: //duckduckgo.com/l/?uddg=<encoded>
			const uddg = href.match(/uddg=([^&]+)/);
			if (uddg) href = decodeURIComponent(uddg[1]);
			const title = m[2].replace(/<[^>]+>/g, "").trim();
			results.push(`${results.length + 1}. ${title}\n   ${href}`);
		}
		if (!results.length) return { ok: false, output: "", error: "no results parsed" };
		return { ok: true, output: results.join("\n") };
	} catch (e) {
		return { ok: false, output: "", error: String(e) };
	}
}

export default function web(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web. Returns a numbered list of results (title + URL). Use web_extract on the URLs you want to read. Prefer this over guessing from memory when a claim depends on current/external facts.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			top: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
			domains: Type.Optional(Type.String({ description: "Comma-separated allowlist of domains" })),
		}),
		executionMode: "parallel",
		async execute(_id, p, signal, _update, _ctx: ExtensionContext) {
			const top = p.top ?? 5;
			const args = ["search", p.query, "--top", String(top)];
			if (p.domains) args.push("--domains", p.domains);
			const vres = await runVsearch(args, { timeoutMs: 45_000, signal });
			if (vres.ok && vres.output.trim()) {
				return { content: [{ type: "text" as const, text: vres.output.trim() }], details: {} };
			}
			const ddg = await ddgSearch(p.query, signal);
			if (ddg.ok) {
				return { content: [{ type: "text" as const, text: ddg.output }], details: {} };
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `web_search failed.\n- vsearch: ${vres.error ?? "empty"}\n- duckduckgo fallback: ${ddg.error ?? "empty"}\n(inferred: network restriction or missing tool. Verify connectivity before retrying.)`,
					},
				],
				details: {},
				isError: true,
			};
		},
	});

	pi.registerTool({
		name: "web_extract",
		label: "Web Extract",
		description:
			"Fetch one or more URLs and return cleaned page text (HTML stripped). Use after web_search to read the actual source before asserting anything about it.",
		parameters: Type.Object({
			urls: Type.Array(Type.String(), { description: "URL(s) to fetch" }),
			maxChars: Type.Optional(Type.Number({ description: "Max chars per page (default 20000)" })),
		}),
		executionMode: "parallel",
		async execute(_id, p, signal, _update, _ctx: ExtensionContext) {
			const maxChars = p.maxChars ?? 20_000;
			const parts: string[] = [];
			for (const u of p.urls.slice(0, 5)) {
				try {
					const res = await fetch(u, {
						signal,
						headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) WaywiserAgent/0.1" },
						redirect: "follow",
					});
					if (!res.ok) {
						parts.push(`### ${u}\n[error HTTP ${res.status}]`);
						continue;
					}
					const raw = await res.text();
					const text = htmlToText(raw);
					const truncated = text.length > maxChars ? text.slice(0, maxChars) + `\n[truncated at ${maxChars} chars]` : text;
					parts.push(`### ${u}\n${truncated.trim()}`);
				} catch (e) {
					parts.push(`### ${u}\n[error ${String(e)}]`);
				}
			}
			return { content: [{ type: "text" as const, text: parts.join("\n\n---\n\n") }], details: {} };
		},
	});
}

/** Dependency-free HTML → readable text. */
export function htmlToText(html: string): string {
	let t = html;
	t = t.replace(/<script[\s\S]*?<\/script>/gi, " ");
	t = t.replace(/<style[\s\S]*?<\/style>/gi, " ");
	t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
	t = t.replace(/<\/(p|div|li|h[1-6]|tr|pre|br)>/gi, "\n");
	t = t.replace(/<br\s*\/?>/gi, "\n");
	t = t.replace(/<li[^>]*>/gi, "- ");
	t = t.replace(/<[^>]+>/g, "");
	t = t
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
	return t
		.split("\n")
		.map((l) => l.replace(/[ \t]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
