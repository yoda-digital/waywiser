/**
 * waywiser-*kanban-server — in-process HTTP server for the kanban board.
 *
 * Serves the live interactive SPA (GET /), a small REST API (/api/boards, /api/cards),
 * and a Server-Sent Events stream (/events) so every mutation (from TUI, tool, or the
 * API itself) shows up in any open browser tab within ~100ms.
 *
 * Bound to 127.0.0.1 only — localhost is the trust boundary (same as pi itself).
 * Zero external deps: node:http only. The HTML itself lives in kanban-html.ts;
 * kanban.ts wires the generator in via setHtmlGenerator() on extension load.
 */
import * as http from "node:http";
import { db_ } from "./utils/state.js";

// Types matching the DB schema (kept local — kanban-html.ts owns the canonical
// BoardRow/CardRow types; these are structurally identical for the API layer).
interface CardRow {
	id: string; board_id: string; title: string; type: string;
	status: string; priority: string; assignee: string | null;
	block_reason: string | null; notes: string | null; report: string | null;
	due: string | null; worker_child: string | null;
	created_at: string; updated_at: string;
}

// Cards are ordered priority-first, then overdue-first, then by due date, then id.
// CASE-based null handling (not "NULLS LAST") for portability across SQLite builds.
const CARD_ORDER =
	"ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'med' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, " +
	"CASE WHEN due IS NULL THEN 1 ELSE 0 END, due ASC, id ASC";

// SSE clients
const sseClients = new Set<http.ServerResponse>();

export function broadcastEvent(event: string, data: unknown): void {
	const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const res of sseClients) {
		try {
			res.write(msg);
		} catch {
			sseClients.delete(res);
		}
	}
}

// Generate next card ID: K1, K2, K3...
function nextCardId(): string {
	const row = db_().prepare("SELECT id FROM cards ORDER BY CAST(SUBSTR(id, 2) AS INTEGER) DESC LIMIT 1").get() as { id: string } | undefined;
	const num = row ? parseInt(row.id.slice(1), 10) + 1 : 1;
	return `K${num}`;
}

function slugify(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "board";
}

// The HTML is served from kanban-html.ts — kanban.ts wires the generator in on load.
let getHtml: (() => string) | undefined;
export function setHtmlGenerator(fn: () => string): void {
	getHtml = fn;
}

export function startBoardServer(port = 7749): Promise<{ port: number; close: () => void }> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			// CORS headers for all responses
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type");

			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}

			const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
			const reqPath = url.pathname;

			// Serve the SPA
			if (reqPath === "/" || reqPath === "/index.html") {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(getHtml ? getHtml() : "<h1>Board not ready</h1>");
				return;
			}

			// SSE endpoint
			if (reqPath === "/events") {
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"Connection": "keep-alive",
				});
				res.write(": connected\n\n");
				sseClients.add(res);
				req.on("close", () => sseClients.delete(res));
				return;
			}

			// REST API: parse JSON body for POST/PUT
			if (req.method === "POST" || req.method === "PUT") {
				let body = "";
				req.on("data", (chunk: Buffer) => {
					body += chunk.toString();
				});
				req.on("end", () => {
					try {
						const data = body ? JSON.parse(body) : {};
						handleApi(req.method!, reqPath, data, url, res);
					} catch {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "invalid JSON" }));
					}
				});
				return;
			}

			handleApi(req.method ?? "GET", reqPath, {}, url, res);
		});

		// Try ports: port, port+1, ..., port+10
		let attempts = 0;
		const tryListen = (p: number): void => {
			server.removeAllListeners("error");
			server.once("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE" && attempts < 10) {
					attempts++;
					tryListen(p + 1);
				} else {
					reject(err);
				}
			});
			server.listen(p, "127.0.0.1", () => {
				// Never let this background dashboard server keep the process alive by
				// itself — it should be reachable if the process is running for other
				// reasons (TUI/RPC), but not the reason it stays up (also matters for
				// tests that invoke the extension's default export with a stub API and
				// no cleanup hook).
				server.unref();
				const addr = server.address();
				const actualPort = typeof addr === "object" && addr ? addr.port : p;
				resolve({ port: actualPort, close: () => server.close() });
			});
		};
		tryListen(port);
	});
}

function handleApi(method: string, reqPath: string, body: Record<string, unknown>, url: URL, res: http.ServerResponse): void {
	const json = (data: unknown, status = 200): void => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
	};

	try {
		const d = db_();

		// GET /api/boards
		if (method === "GET" && reqPath === "/api/boards") {
			const boards = d
				.prepare(
					"SELECT b.*, " +
						"(SELECT COUNT(*) FROM cards c WHERE c.board_id = b.id) as cardCount, " +
						"(SELECT COUNT(*) FROM cards c WHERE c.board_id = b.id AND c.due IS NOT NULL AND c.status != 'done' AND datetime(c.due) < datetime('now')) as overdueCount " +
						"FROM boards b WHERE b.archived = 0 ORDER BY (b.id = 'default') DESC, b.name ASC",
				)
				.all();
			return json(boards);
		}

		// POST /api/boards
		if (method === "POST" && reqPath === "/api/boards") {
			const name = String(body.name ?? "").trim();
			if (!name) return json({ error: "name required" }, 400);
			const id = slugify(name);
			d.prepare("INSERT OR IGNORE INTO boards (id, name, description) VALUES (?, ?, ?)").run(id, name, String(body.description ?? "") || null);
			broadcastEvent("board_changed", { boardId: id, action: "created" });
			return json({ id, name }, 201);
		}

		// PUT /api/boards/:id
		const boardMatch = reqPath.match(/^\/api\/boards\/([^/]+)$/);
		if (method === "PUT" && boardMatch) {
			const boardId = boardMatch[1];
			const existing = d.prepare("SELECT * FROM boards WHERE id = ?").get(boardId);
			if (!existing) return json({ error: `no board ${boardId}` }, 404);
			const fields: string[] = [];
			const values: unknown[] = [];
			if (typeof body.name === "string") {
				fields.push("name = ?");
				values.push(body.name);
			}
			if (typeof body.description === "string" || body.description === null) {
				fields.push("description = ?");
				values.push(body.description);
			}
			if (fields.length) {
				values.push(boardId);
				d.prepare(`UPDATE boards SET ${fields.join(", ")} WHERE id = ?`).run(...values);
			}
			const updated = d.prepare("SELECT * FROM boards WHERE id = ?").get(boardId);
			broadcastEvent("board_changed", { boardId, action: "updated" });
			return json(updated);
		}

		// DELETE /api/boards/:id
		if (method === "DELETE" && boardMatch) {
			const boardId = boardMatch[1];
			if (boardId === "default") return json({ error: "cannot delete default board" }, 400);
			const existing = d.prepare("SELECT id FROM boards WHERE id = ?").get(boardId);
			if (!existing) return json({ error: `no board ${boardId}` }, 404);
			d.prepare("DELETE FROM cards WHERE board_id = ?").run(boardId);
			d.prepare("DELETE FROM boards WHERE id = ?").run(boardId);
			broadcastEvent("board_changed", { boardId, action: "deleted" });
			return json({ ok: true });
		}

		// GET /api/cards?board=xxx
		if (method === "GET" && reqPath === "/api/cards") {
			const boardId = url.searchParams.get("board");
			const cards = boardId
				? d.prepare(`SELECT * FROM cards WHERE board_id = ? ${CARD_ORDER}`).all(boardId)
				: d.prepare(`SELECT * FROM cards ${CARD_ORDER.replace("ORDER BY", "ORDER BY board_id,")}`).all();
			return json(cards);
		}

		// POST /api/cards
		if (method === "POST" && reqPath === "/api/cards") {
			const title = String(body.title ?? "").trim();
			if (!title) return json({ error: "title required" }, 400);
			const id = nextCardId();
			const boardId = String(body.board_id ?? "default");
			const type = String(body.type ?? "task");
			const status = String(body.status ?? "todo");
			const priority = String(body.priority ?? "med");
			const due = body.due ? String(body.due) : null;
			d.prepare("INSERT OR IGNORE INTO boards (id, name) VALUES (?, ?)").run(boardId, boardId);
			d.prepare("INSERT INTO cards (id, board_id, title, type, status, priority, due) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, boardId, title, type, status, priority, due);
			const card = d.prepare("SELECT * FROM cards WHERE id = ?").get(id);
			broadcastEvent("card_created", card);
			return json(card, 201);
		}

		// PUT /api/cards/:id
		const cardMatch = reqPath.match(/^\/api\/cards\/([^/]+)$/);
		if (method === "PUT" && cardMatch) {
			const cardId = cardMatch[1];
			const existing = d.prepare("SELECT * FROM cards WHERE id = ?").get(cardId) as CardRow | undefined;
			if (!existing) return json({ error: `no card ${cardId}` }, 404);

			const fields: string[] = [];
			const values: unknown[] = [];
			for (const [key, val] of Object.entries(body)) {
				if (["title", "status", "priority", "type", "due", "notes", "assignee", "block_reason", "report", "board_id"].includes(key)) {
					fields.push(`${key} = ?`);
					values.push(val === null ? null : String(val));
				}
			}
			if (fields.length) {
				fields.push("updated_at = datetime('now')");
				values.push(cardId);
				d.prepare(`UPDATE cards SET ${fields.join(", ")} WHERE id = ?`).run(...values);
			}
			const updated = d.prepare("SELECT * FROM cards WHERE id = ?").get(cardId);
			broadcastEvent("card_updated", updated);
			return json(updated);
		}

		// DELETE /api/cards/:id
		if (method === "DELETE" && cardMatch) {
			const cardId = cardMatch[1];
			const existing = d.prepare("SELECT id FROM cards WHERE id = ?").get(cardId);
			if (!existing) return json({ error: `no card ${cardId}` }, 404);
			d.prepare("DELETE FROM cards WHERE id = ?").run(cardId);
			broadcastEvent("card_deleted", { id: cardId });
			return json({ ok: true });
		}

		// 404
		json({ error: "not found" }, 404);
	} catch (e) {
		json({ error: e instanceof Error ? e.message : String(e) }, 500);
	}
}
