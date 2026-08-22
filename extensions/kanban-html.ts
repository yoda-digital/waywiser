/**
 * kanban-html.ts — HTML generators for the Waywiser kanban board.
 *
 * Two exports:
 *  generateBoardHtml()    → live interactive SPA (talks to localhost REST API + SSE)
 *  generateStaticSnapshot() → offline read-only fallback (all data baked in)
 */
import { getBoardToken } from "./kanban-server.js";

export interface BoardRow {
	id: string;
	name: string;
	description: string | null;
	archived: number;
}

export interface CardRow {
	id: string;
	board_id: string;
	title: string;
	type: string;
	status: string;
	priority: string;
	assignee: string | null;
	block_reason: string | null;
	notes: string | null;
	report: string | null;
	due: string | null;
	worker_child: string | null;
	created_at: string;
	updated_at: string;
}

function escHtml(s: string | null | undefined): string {
	if (!s) return "";
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const TYPE_ICON: Record<string, string> = { task: "📋", idea: "💡", bug: "🐛" };
const STATUS_LABEL: Record<string, string> = { todo: "📋 TODO", doing: "⚡ DOING", review: "🔍 REVIEW", done: "✅ DONE" };
const COLUMNS = ["todo", "doing", "review", "done"] as const;
const PRI_ORDER = ["critical", "high", "med", "low"];

function isOverdue(c: CardRow): boolean {
	return !!c.due && c.status !== "done" && new Date(c.due).getTime() < Date.now();
}

function sortCards(cards: CardRow[]): CardRow[] {
	return [...cards].sort((a, b) => {
		const pa = PRI_ORDER.indexOf(a.priority);
		const pb = PRI_ORDER.indexOf(b.priority);
		if (pa !== pb) return pa - pb;
		const oa = isOverdue(a) ? 0 : 1;
		const ob = isOverdue(b) ? 0 : 1;
		if (oa !== ob) return oa - ob;
		return a.id.localeCompare(b.id);
	});
}

function fmtDate(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ─── shared CSS ────────────────────────────────────────────────────────
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f5f6fa;--bg2:#fff;--fg:#23232b;--fg2:#555;--border:#dde1e8;
  --col-bg:#ebeef3;--card-bg:#fff;--card-shadow:0 1px 3px rgba(0,0,0,.08);
  --pri-critical:#e74c3c;--pri-high:#f39c12;--pri-med:#3498db;--pri-low:#95a5a6;
  --accent:#6c5ce7;--danger:#e74c3c;--success:#27ae60;
}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0f0f1a;--bg2:#1a1a2e;--fg:#e0e0e8;--fg2:#a0a0b0;--border:#2a2a40;
  --col-bg:#16213e;--card-bg:#1e2a45;--card-shadow:0 1px 4px rgba(0,0,0,.3);
}}
:root[data-theme="dark"]{
  --bg:#0f0f1a;--bg2:#1a1a2e;--fg:#e0e0e8;--fg2:#a0a0b0;--border:#2a2a40;
  --col-bg:#16213e;--card-bg:#1e2a45;--card-shadow:0 1px 4px rgba(0,0,0,.3);
}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh}
header{background:var(--bg2);border-bottom:1px solid var(--border);padding:.8rem 1.2rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
header h1{font-size:1.15rem;white-space:nowrap}
.tabs{display:flex;gap:.35rem;flex-wrap:wrap}
.tab{padding:.3rem .7rem;border-radius:6px;border:1px solid var(--border);background:var(--bg);cursor:pointer;font-size:.82rem;transition:all .15s}
.tab.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.tab:hover:not(.active){background:var(--col-bg)}
.tab-add{border-style:dashed;color:var(--fg2)}
.theme-toggle{margin-left:auto;cursor:pointer;font-size:1.2rem;background:none;border:none;padding:.3rem}
.stats{padding:.45rem 1.2rem;font-size:.82rem;color:var(--fg2);border-bottom:1px solid var(--border);background:var(--bg2)}
.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.8rem;padding:1rem;flex:1}
.column{background:var(--col-bg);border-radius:10px;padding:.6rem;min-height:200px;display:flex;flex-direction:column;transition:border .15s}
.column.drag-over{border:2px dashed var(--accent)}
.col-header{display:flex;align-items:center;justify-content:space-between;padding:0 .3rem .5rem;font-weight:600;font-size:.85rem}
.col-header button{background:none;border:none;cursor:pointer;font-size:1rem;color:var(--fg2);border-radius:4px;width:26px;height:26px;display:flex;align-items:center;justify-content:center}
.col-header button:hover{background:var(--border)}
.cards{display:flex;flex-direction:column;gap:.45rem;flex:1}
.card{background:var(--card-bg);border-radius:8px;padding:.55rem .65rem;box-shadow:var(--card-shadow);cursor:grab;border-left:3px solid transparent;transition:transform .12s,box-shadow .12s}
.card:hover{transform:translateY(-1px);box-shadow:0 3px 8px rgba(0,0,0,.12)}
.card.dragging{opacity:.4}
.card.overdue{border-left-color:var(--danger)}
.card.pri-critical{border-left-color:var(--pri-critical)}
.card.pri-high{border-left-color:var(--pri-high)}
.card.pri-med{border-left-color:var(--pri-med)}
.card.pri-low{border-left-color:var(--pri-low)}
.card-head{display:flex;align-items:center;gap:.4rem;font-size:.82rem}
.card-id{font-weight:700;color:var(--accent);font-size:.75rem}
.card-title{flex:1;font-weight:500}
.card-actions{display:flex;gap:.15rem;opacity:0;transition:opacity .12s}
.card:hover .card-actions{opacity:1}
.card-actions button{background:none;border:none;cursor:pointer;font-size:.78rem;color:var(--fg2);padding:2px 4px;border-radius:3px}
.card-actions button:hover{background:var(--border)}
.badge{font-size:.65rem;padding:1px 5px;border-radius:3px;font-weight:600;text-transform:uppercase}
.badge-overdue{background:var(--danger);color:#fff}
.badge-pri{color:#fff}
.badge-pri.critical{background:var(--pri-critical)}.badge-pri.high{background:var(--pri-high)}
.badge-pri.med{background:var(--pri-med)}.badge-pri.low{background:var(--pri-low)}
.card-meta{font-size:.72rem;color:var(--fg2);margin-top:.25rem;display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}
.card-expand{font-size:.78rem;color:var(--fg2);margin-top:.35rem;border-top:1px solid var(--border);padding-top:.35rem}
.card-expand textarea,.card-expand input,.card-expand select{width:100%;margin:.2rem 0;padding:.3rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);font:inherit;font-size:.78rem}
.card-expand textarea{min-height:50px;resize:vertical}
.card-expand .save-row{display:flex;gap:.3rem;margin-top:.3rem}
.card-expand .save-row button{padding:.25rem .6rem;border:none;border-radius:4px;cursor:pointer;font-size:.75rem}
.card-expand .btn-save{background:var(--accent);color:#fff}
.card-expand .btn-cancel{background:var(--border);color:var(--fg)}
.add-form{background:var(--card-bg);border-radius:8px;padding:.55rem;margin-bottom:.4rem;box-shadow:var(--card-shadow)}
.add-form input,.add-form select{width:100%;padding:.3rem;margin:.15rem 0;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);font:inherit;font-size:.78rem}
.add-form .form-row{display:flex;gap:.3rem}
.add-form .form-row>*{flex:1}
.add-form .form-actions{display:flex;gap:.3rem;margin-top:.3rem}
.blocked-bar{margin:0 1rem 1rem;background:var(--col-bg);border-radius:10px;padding:.6rem .8rem}
.blocked-bar h3{font-size:.82rem;margin-bottom:.35rem;color:var(--danger)}
.blocked-card{display:inline-flex;align-items:center;gap:.4rem;background:var(--card-bg);border-radius:6px;padding:.3rem .6rem;margin:.2rem .3rem .2rem 0;font-size:.78rem;border-left:3px solid var(--danger)}
.blocked-card button{background:none;border:none;cursor:pointer;font-size:.82rem}
footer{background:var(--bg2);border-top:1px solid var(--border);padding:.4rem 1.2rem;font-size:.72rem;color:var(--fg2);display:flex;align-items:center;gap:.8rem}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:.3rem}
.dot.on{background:var(--success)}.dot.off{background:var(--danger)}
.static-banner{background:#fff3cd;color:#856404;padding:.6rem 1.2rem;text-align:center;font-size:.85rem;border-bottom:1px solid #ffc107}
@media(prefers-color-scheme:dark){.static-banner{background:#4a3c00;color:#ffd866}}
.worker-pulse{display:inline-block;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
`;

// ─── card HTML builder (shared between live and static) ────────────────
function renderCardHtml(c: CardRow, interactive: boolean): string {
	const od = isOverdue(c);
	const cls = [`card`, `pri-${c.priority}`, od ? "overdue" : ""].filter(Boolean).join(" ");
	const icon = TYPE_ICON[c.type] ?? "";
	const dueFmt = c.due ? fmtDate(c.due) : "";

	const actions = interactive
		? `<span class="card-actions">
			<button onclick="editCard('${escHtml(c.id)}')" title="Edit">✎</button>
			<button onclick="deleteCard('${escHtml(c.id)}')" title="Delete">×</button>
		   </span>`
		: "";

	const worker = c.worker_child ? `<span class="worker-pulse" title="Subagent working">⏳</span>` : "";

	return `<div class="${cls}" draggable="${interactive}" data-id="${escHtml(c.id)}" data-status="${escHtml(c.status)}"
		${interactive ? `ondragstart="onDragStart(event)" ondragend="onDragEnd(event)"` : ""}>
		<div class="card-head">
			<span class="card-id">${escHtml(c.id)}</span>
			${icon ? `<span>${icon}</span>` : ""}
			<span class="card-title">${escHtml(c.title)}</span>
			${worker}
			${actions}
		</div>
		<div class="card-meta">
			<span class="badge badge-pri ${escHtml(c.priority)}">${escHtml(c.priority)}</span>
			${od ? `<span class="badge badge-overdue">⚠️ OVERDUE</span>` : ""}
			${dueFmt ? `<span>📅 ${escHtml(dueFmt)}</span>` : ""}
			${c.assignee ? `<span>→ ${escHtml(c.assignee)}</span>` : ""}
		</div>
		<div class="card-expand" id="expand-${escHtml(c.id)}" style="display:none">
			${interactive ? `
			<label>Title<input id="ed-title-${escHtml(c.id)}" value="${escHtml(c.title)}"></label>
			<div class="form-row">
				<label>Priority<select id="ed-pri-${escHtml(c.id)}">
					${["low","med","high","critical"].map(p => `<option${p===c.priority?" selected":""}>${p}</option>`).join("")}
				</select></label>
				<label>Type<select id="ed-type-${escHtml(c.id)}">
					${["task","idea","bug"].map(t => `<option${t===c.type?" selected":""}>${t}</option>`).join("")}
				</select></label>
			</div>
			<label>Due<input type="date" id="ed-due-${escHtml(c.id)}" value="${escHtml(dueFmt)}"></label>
			<label>Notes<textarea id="ed-notes-${escHtml(c.id)}">${escHtml(c.notes)}</textarea></label>
			${c.report ? `<label>Report (read-only)<textarea readonly>${escHtml(c.report)}</textarea></label>` : ""}
			<div class="save-row">
				<button class="btn-save" onclick="saveCard('${escHtml(c.id)}')">Save</button>
				<button class="btn-cancel" onclick="toggleExpand('${escHtml(c.id)}')">Cancel</button>
			</div>` : `
			${c.notes ? `<div><strong>Notes:</strong> ${escHtml(c.notes)}</div>` : ""}
			${c.report ? `<div><strong>Report:</strong> ${escHtml(c.report)}</div>` : ""}
			<div style="margin-top:.2rem">Created: ${escHtml(c.created_at)} · Updated: ${escHtml(c.updated_at)}</div>
			`}
		</div>
	</div>`;
}

// ─── live interactive SPA ──────────────────────────────────────────────
export function generateBoardHtml(
	boards: BoardRow[],
	cards: CardRow[],
	activeBoardId: string,
	serverPort: number,
	boardToken?: string,
): string {
	const token = boardToken ?? getBoardToken();
	const activeBoards = boards.filter(b => !b.archived);
	const boardCards = sortCards(cards.filter(c => c.board_id === activeBoardId));
	const blocked = boardCards.filter(c => c.status === "blocked");
	const open = boardCards.filter(c => c.status !== "done").length;
	const overdue = boardCards.filter(c => isOverdue(c)).length;
	const done = boardCards.filter(c => c.status === "done").length;
	const blockedN = blocked.length;

	const tabsHtml = activeBoards.map(b =>
		`<button class="tab${b.id === activeBoardId ? " active" : ""}" onclick="switchBoard('${escHtml(b.id)}')">${escHtml(b.name)}</button>`
	).join("");

	const columnsHtml = COLUMNS.map(st => {
		const colCards = sortCards(boardCards.filter(c => c.status === st));
		return `<div class="column" data-status="${st}"
			ondragover="onDragOver(event)" ondragleave="onDragLeave(event)" ondrop="onDrop(event)">
			<div class="col-header">
				<span>${STATUS_LABEL[st] ?? st} (${colCards.length})</span>
				<button onclick="showAddForm('${st}')" title="Add card">＋</button>
			</div>
			<div id="add-${st}"></div>
			<div class="cards">${colCards.map(c => renderCardHtml(c, true)).join("")}</div>
		</div>`;
	}).join("");

	const blockedHtml = blocked.length ? `<div class="blocked-bar">
		<h3>🔴 Blocked (${blocked.length})</h3>
		${blocked.map(c => `<span class="blocked-card">
			<strong>${escHtml(c.id)}</strong> ${escHtml(c.title)}
			${c.block_reason ? `<em>(${escHtml(c.block_reason)})</em>` : ""}
			<button onclick="unblock('${escHtml(c.id)}')" title="Unblock">▶</button>
			<button onclick="editCard('${escHtml(c.id)}')" title="Edit">✎</button>
		</span>`).join("")}
	</div>` : "";

	const js = `
const API = 'http://localhost:${serverPort}/api';
const TOKEN = '${token}';
const AUTH_HEADERS = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN };
let activeBoard = '${escHtml(activeBoardId)}';

// ── SSE ──
let evtSrc;
function connectSSE() {
	evtSrc = new EventSource('http://localhost:${serverPort}/events?token=' + TOKEN);
	evtSrc.onopen = () => { document.getElementById('conn-dot').className='dot on'; document.getElementById('conn-text').textContent='Connected'; };
	evtSrc.onerror = () => { document.getElementById('conn-dot').className='dot off'; document.getElementById('conn-text').textContent='Disconnected'; };
	evtSrc.onmessage = (e) => {
		document.getElementById('last-evt').textContent = new Date().toLocaleTimeString();
		location.reload();
	};
	['card_created','card_updated','card_deleted','board_changed'].forEach(ev => {
		evtSrc.addEventListener(ev, () => {
			document.getElementById('last-evt').textContent = new Date().toLocaleTimeString();
			location.reload();
		});
	});
}
connectSSE();

// ── drag & drop ──
let dragId = null;
function onDragStart(e) { dragId = e.target.closest('.card').dataset.id; e.target.closest('.card').classList.add('dragging'); e.dataTransfer.effectAllowed='move'; }
function onDragEnd(e) { dragId = null; e.target.closest('.card')?.classList.remove('dragging'); document.querySelectorAll('.column').forEach(c=>c.classList.remove('drag-over')); }
function onDragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function onDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
async function onDrop(e) {
	e.preventDefault(); e.currentTarget.classList.remove('drag-over');
	const status = e.currentTarget.dataset.status;
	if (!dragId || !status) return;
	await fetch(API+'/cards/'+dragId, { method:'PUT', headers:AUTH_HEADERS, body:JSON.stringify({status}) });
}

// ── CRUD ──
function showAddForm(status) {
	const el = document.getElementById('add-'+status);
	if (el.innerHTML) { el.innerHTML=''; return; }
	el.innerHTML = '<div class="add-form"><input id="new-title-'+status+'" placeholder="Card title…" autofocus>'
		+'<div class="form-row"><select id="new-type-'+status+'"><option>task</option><option>idea</option><option>bug</option></select>'
		+'<select id="new-pri-'+status+'"><option>low</option><option selected>med</option><option>high</option><option>critical</option></select></div>'
		+'<input type="date" id="new-due-'+status+'">'
		+'<div class="form-actions"><button class="btn-save" onclick="addCard(\\''+status+'\\')">Add</button>'
		+'<button class="btn-cancel" onclick="document.getElementById(\\'add-'+status+'\\').innerHTML=\\'\\'">Cancel</button></div></div>';
	document.getElementById('new-title-'+status).focus();
}
async function addCard(status) {
	const title = document.getElementById('new-title-'+status).value.trim();
	if (!title) return;
	const body = { title, status, board_id: activeBoard,
		type: document.getElementById('new-type-'+status).value,
		priority: document.getElementById('new-pri-'+status).value,
		due: document.getElementById('new-due-'+status).value || undefined };
	await fetch(API+'/cards', { method:'POST', headers:AUTH_HEADERS, body:JSON.stringify(body) });
}
function toggleExpand(id) {
	const el = document.getElementById('expand-'+id);
	el.style.display = el.style.display==='none' ? 'block' : 'none';
}
function editCard(id) { toggleExpand(id); }
async function saveCard(id) {
	const body = {
		title: document.getElementById('ed-title-'+id).value,
		priority: document.getElementById('ed-pri-'+id).value,
		type: document.getElementById('ed-type-'+id).value,
		due: document.getElementById('ed-due-'+id).value || null,
		notes: document.getElementById('ed-notes-'+id).value || null,
	};
	await fetch(API+'/cards/'+id, { method:'PUT', headers:AUTH_HEADERS, body:JSON.stringify(body) });
}
async function deleteCard(id) {
	if (!confirm('Delete card '+id+'?')) return;
	await fetch(API+'/cards/'+id, { method:'DELETE', headers:AUTH_HEADERS });
}
async function unblock(id) {
	await fetch(API+'/cards/'+id, { method:'PUT', headers:AUTH_HEADERS, body:JSON.stringify({status:'todo',block_reason:null}) });
}
function switchBoard(id) {
	activeBoard = id;
	localStorage.setItem('waywiser-board', id);
	location.reload();
}
function addBoard() {
	const name = prompt('New board name:');
	if (!name) return;
	fetch(API+'/boards', { method:'POST', headers:AUTH_HEADERS, body:JSON.stringify({name}) })
		.then(() => location.reload());
}
function toggleTheme() {
	const r = document.documentElement;
	const next = r.getAttribute('data-theme')==='dark' ? 'light' : 'dark';
	r.setAttribute('data-theme', next);
	localStorage.setItem('waywiser-theme', next);
}
// restore prefs
(function(){
	const t = localStorage.getItem('waywiser-theme');
	if (t) document.documentElement.setAttribute('data-theme', t);
	const b = localStorage.getItem('waywiser-board');
	if (b && b !== activeBoard) { activeBoard = b; location.replace(location.pathname+'?board='+b); }
})();
`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waywiser Board</title>
<style>${CSS}</style>
<script>window.__WAYWISER_TOKEN="${token}"</script>
</head>
<body style="display:flex;flex-direction:column;min-height:100vh">
<header>
	<h1>📋 Waywiser Board</h1>
	<div class="tabs">${tabsHtml}<button class="tab tab-add" onclick="addBoard()">+ Board</button></div>
	<button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">🌓</button>
</header>
<div class="stats">${open} open · ${overdue} overdue · ${done} done · ${blockedN} blocked</div>
<div class="board">${columnsHtml}</div>
${blockedHtml}
<footer>
	<span><span class="dot off" id="conn-dot"></span><span id="conn-text">Connecting…</span></span>
	<span>Last event: <span id="last-evt">—</span></span>
	<span>localhost:${serverPort}</span>
</footer>
<script>${js}</script>
</body>
</html>`;
}

// ─── static snapshot (offline fallback) ────────────────────────────────
export function generateStaticSnapshot(
	boards: BoardRow[],
	cards: CardRow[],
	activeBoardId: string,
): string {
	const activeBoards = boards.filter(b => !b.archived);
	const boardCards = sortCards(cards.filter(c => c.board_id === activeBoardId));
	const blocked = boardCards.filter(c => c.status === "blocked");
	const open = boardCards.filter(c => c.status !== "done").length;
	const overdue = boardCards.filter(c => isOverdue(c)).length;
	const done = boardCards.filter(c => c.status === "done").length;
	const blockedN = blocked.length;

	const tabsHtml = activeBoards.map(b =>
		`<span class="tab${b.id === activeBoardId ? " active" : ""}">${escHtml(b.name)}</span>`
	).join("");

	const columnsHtml = COLUMNS.map(st => {
		const colCards = sortCards(boardCards.filter(c => c.status === st));
		return `<div class="column">
			<div class="col-header"><span>${STATUS_LABEL[st] ?? st} (${colCards.length})</span></div>
			<div class="cards">${colCards.map(c => renderCardHtml(c, false)).join("")}</div>
		</div>`;
	}).join("");

	const blockedHtml = blocked.length ? `<div class="blocked-bar">
		<h3>🔴 Blocked (${blocked.length})</h3>
		${blocked.map(c => `<span class="blocked-card">
			<strong>${escHtml(c.id)}</strong> ${escHtml(c.title)}
			${c.block_reason ? `<em>(${escHtml(c.block_reason)})</em>` : ""}
		</span>`).join("")}
	</div>` : "";

	// toggle expand for static cards (notes/report visibility)
	const staticJs = `function toggleExpand(id){var e=document.getElementById('expand-'+id);e.style.display=e.style.display==='none'?'block':'none';}
document.querySelectorAll('.card').forEach(c=>c.style.cursor='pointer');
document.querySelectorAll('.card').forEach(c=>c.onclick=function(){var id=this.dataset.id;if(id)toggleExpand(id);});`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waywiser Board (snapshot)</title>
<style>${CSS}</style>
</head>
<body style="display:flex;flex-direction:column;min-height:100vh">
<div class="static-banner">⚠️ Static snapshot — start waywiser for the live board at <strong>http://localhost:7749/</strong></div>
<header>
	<h1>📋 Waywiser Board</h1>
	<div class="tabs">${tabsHtml}</div>
</header>
<div class="stats">${open} open · ${overdue} overdue · ${done} done · ${blockedN} blocked</div>
<div class="board">${columnsHtml}</div>
${blockedHtml}
<footer>
	<span>Snapshot generated: ${new Date().toISOString().replace("T", " ").slice(0, 19)}</span>
</footer>
<script>${staticJs}</script>
</body>
</html>`;
}
