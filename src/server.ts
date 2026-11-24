import { formatAmount, type Nod, type NodRequest } from "./nod";

export type ServeOptions = { nod: Nod; port?: number; hostname?: string };

const MARK = `<svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true"><path d="M14 0 H46 L64 18 V50 Q64 64 50 64 H14 Q0 64 0 50 V14 Q0 0 14 0 Z" fill="#112553"/><path d="M19 33 L28 42 L45 22" fill="none" stroke="#4ADE80" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #0C1A3A; color: #E2E8F5; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; justify-content: center; padding: 48px 16px; }
main { width: 100%; max-width: 560px; }
header { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; font: 700 18px ui-monospace, SFMono-Regular, Menlo, monospace; color: #4ADE80; }
.card { background: #112553; border-radius: 14px; padding: 28px; }
.action { font: 600 13px ui-monospace, SFMono-Regular, Menlo, monospace; color: #B5C3E3; letter-spacing: .02em; }
h1 { font-size: 22px; line-height: 1.3; margin: 6px 0 4px; color: #fff; }
.amount { font: 700 32px ui-monospace, SFMono-Regular, Menlo, monospace; color: #4ADE80; margin: 12px 0 4px; }
pre { background: #0C1A3A; border-radius: 10px; padding: 14px; overflow-x: auto; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #B5C3E3; }
.meta { color: #8396BE; font-size: 13px; margin-top: 16px; }
form { display: flex; gap: 12px; margin-top: 24px; }
button { flex: 1; font: 700 16px system-ui, sans-serif; padding: 14px; border-radius: 10px; cursor: pointer; border: 2px solid transparent; }
.approve { background: #4ADE80; color: #0C1A3A; }
.deny { background: transparent; color: #E2E8F5; border-color: #3A4E7D; }
button:focus-visible { outline: 3px solid #E2E8F5; outline-offset: 2px; }
.status { display: inline-block; margin-top: 20px; padding: 6px 12px; border-radius: 999px; font: 700 13px ui-monospace, SFMono-Regular, Menlo, monospace; background: #0C1A3A; }
.approved { color: #4ADE80; } .denied { color: #F87171; } .expired, .pending { color: #B5C3E3; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
td { padding: 10px 6px; border-top: 1px solid #1D3366; vertical-align: top; }
td:first-child { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #B5C3E3; white-space: nowrap; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(title)} · nod</title><style>${STYLE}</style></head><body><main><header>${MARK}nod</header>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

function details(request: NodRequest): string {
  const amount = formatAmount(request);
  const payload = request.payload === null ? "" : `<pre>${escape(JSON.stringify(request.payload, null, 2))}</pre>`;
  return `<div class="action">${escape(request.action)} · ${escape(request.id)}</div>
<h1>${escape(request.summary)}</h1>
${amount ? `<div class="amount">${escape(amount)}</div>` : ""}
${payload}
<div class="meta">Requested ${new Date(request.createdAt).toUTCString()}${request.status === "pending" ? ` · expires ${new Date(request.expiresAt).toUTCString()}` : ""}</div>`;
}

function outcome(request: NodRequest): string {
  const by = request.decidedBy ? ` by ${escape(request.decidedBy)}` : "";
  const ran = request.executed ? " · executed" : "";
  return `<span class="status ${request.status}">${request.status}${request.status === "approved" || request.status === "denied" ? by : ""}${ran}</span>`;
}

export function serveApprovals(options: ServeOptions) {
  const { nod } = options;
  return Bun.serve({
    port: options.port ?? 4747,
    hostname: options.hostname ?? "127.0.0.1",
    routes: {
      "/": {
        GET: () => {
          const rows = nod
            .list({ all: true, limit: 25 })
            .map((r) => `<tr><td>${escape(r.id)}</td><td>${escape(r.summary)}<br><span class="meta">${escape(r.action)} ${escape(formatAmount(r))}</span></td><td><span class="${r.status}">${r.status}${r.executed ? " · ran" : ""}</span></td></tr>`)
            .join("");
          return page("Requests", `<div class="card"><table>${rows || `<tr><td>No requests yet.</td></tr>`}</table><p class="meta">Decisions are made from the link sent with each request, or with <code>nod approve &lt;id&gt;</code>.</p></div>`);
        },
      },
      "/r/:id": {
        GET: (request) => {
          const record = nod.get(request.params.id);
          if (!record) return page("Not found", `<div class="card"><h1>No such request.</h1></div>`, 404);
          if (record.status !== "pending") return page(record.summary, `<div class="card">${details(record)}${outcome(record)}</div>`);
          const token = new URL(request.url).searchParams.get("t") ?? "";
          if (!nod.checkToken(record.id, token)) {
            return page(record.summary, `<div class="card">${details(record)}<p class="meta">This link is not valid any more. Run <code>nod link ${escape(record.id)}</code> for a fresh one.</p></div>`, 403);
          }
          return page(
            record.summary,
            `<div class="card">${details(record)}<form method="post" action="/r/${escape(record.id)}"><input type="hidden" name="t" value="${escape(token)}"><button class="approve" name="decision" value="approve">Approve</button><button class="deny" name="decision" value="deny">Deny</button></form></div>`,
          );
        },
        POST: async (request) => {
          const form = await request.formData().catch(() => new FormData());
          const decision = form.get("decision");
          const token = String(form.get("t") ?? "");
          if (decision !== "approve" && decision !== "deny") return page("Bad request", `<div class="card"><h1>Choose approve or deny.</h1></div>`, 400);
          const result = nod.decide(request.params.id, decision === "approve" ? "approved" : "denied", { by: "web", token });
          if (!result.request) return page("Not found", `<div class="card"><h1>No such request.</h1></div>`, 404);
          const note = result.ok ? "" : `<p class="meta">${result.reason === "invalid_token" ? "This link is not valid any more." : "This request was already decided."}</p>`;
          return page(result.request.summary, `<div class="card">${details(result.request)}${outcome(result.request)}${note}</div>`, result.ok ? 200 : 409);
        },
      },
      "/api/r/:id": {
        GET: (request) => {
          const record = nod.get(request.params.id);
          if (!record) return Response.json({ error: "not_found" }, { status: 404 });
          return Response.json({ id: record.id, status: record.status, executed: record.executed, decidedBy: record.decidedBy });
        },
      },
    },
    fetch: () => page("Not found", `<div class="card"><h1>Not found.</h1></div>`, 404),
  });
}
