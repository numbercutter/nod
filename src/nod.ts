import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { slackPost, slackUpdate, type SlackOptions } from "./slack";

export type Status = "pending" | "approved" | "denied" | "expired";

export type Vote = { approver: string; decision: Decision; reason: string | null; at: number };

export type NodRequest = {
  id: string;
  action: string;
  summary: string;
  amount: number | null;
  currency: string;
  payload: unknown;
  status: Status;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  reason: string | null;
  requiredApprovals: number;
  approvers: string[] | null;
  onExpiry: "expired" | "denied";
  votes: Vote[];
  idempotencyKey: string;
  executed: boolean;
  executedAt: number | null;
  runAttempts: number;
  result: unknown;
  slack: { channel: string; ts: string } | null;
};

export type RequestInput = {
  action: string;
  summary: string;
  amount?: number;
  currency?: string;
  payload?: unknown;
  expiresIn?: number | string;
};

export type RunContext = {
  id: string;
  idempotencyKey: string;
  action: string;
  amount: number | null;
  currency: string;
  payload: unknown;
  attempt: number;
};

export type RunOutcome<T> = { ran: true; result: T } | { ran: false; reason: "already_executed"; result: T };

export type Decision = "approved" | "denied";

export type DecideOptions = { by: string; token?: string; reason?: string };

export type DecideResult = { ok: true; request: NodRequest } | { ok: false; reason: string; request: NodRequest | null };

export type Rule = {
  action?: string;
  minAmount?: number;
  approvals?: number;
  approvers?: string[];
  onExpiry?: "expired" | "denied";
};

export type NodConfig = Rule & { rules?: Rule[] };

export type Policy = { requiredApprovals: number; approvers: string[] | null; onExpiry: "expired" | "denied" };

export type NodOptions = {
  path?: string;
  baseUrl?: string;
  slackWebhook?: string;
  slack?: Partial<SlackOptions>;
  config?: NodConfig | string;
  log?: (message: string) => void;
};

type Row = {
  id: string;
  action: string;
  summary: string;
  amount: number | null;
  currency: string;
  payload: string;
  status: Status;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  decided_by: string | null;
  reason: string | null;
  required_approvals: number;
  approvers: string | null;
  on_expiry: "expired" | "denied";
  idempotency_key: string;
  executed: number;
  executed_at: number | null;
  run_started_at: number | null;
  run_attempts: number;
  result: string | null;
  slack_channel: string | null;
  slack_ts: string | null;
};

export class NodError extends Error {}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(value: number | string): number {
  if (typeof value === "number") return value * 1000;
  const match = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(value.trim());
  if (!match) throw new NodError(`cannot read duration "${value}", use seconds or forms like 30m, 4h, 2d`);
  return Number(match[1]) * UNITS[match[2]];
}

function randomId(prefix: string, bytes: number): string {
  return prefix + Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export function formatAmount(request: Pick<NodRequest, "amount" | "currency">): string {
  if (request.amount === null) return "";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: request.currency }).format(request.amount);
  } catch {
    return `${request.amount} ${request.currency}`;
  }
}

export function loadConfig(source?: NodConfig | string): NodConfig {
  if (source && typeof source === "object") return source;
  const file = source ?? process.env.NOD_CONFIG ?? "nod.config.json";
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function matches(rule: Rule, input: { action: string; amount: number | null }): boolean {
  if (rule.action) {
    const prefix = rule.action.endsWith("*") ? rule.action.slice(0, -1) : null;
    if (prefix === null ? rule.action !== input.action : !input.action.startsWith(prefix)) return false;
  }
  if (rule.minAmount !== undefined && (input.amount === null || input.amount < rule.minAmount)) return false;
  return true;
}

export function resolvePolicy(config: NodConfig, input: { action: string; amount: number | null }): Policy {
  const rule = (config.rules ?? []).find((candidate) => matches(candidate, input)) ?? {};
  const approvers = rule.approvers ?? config.approvers ?? null;
  const requiredApprovals = Math.max(1, Math.floor(rule.approvals ?? config.approvals ?? 1));
  if (approvers && approvers.length < requiredApprovals) {
    throw new NodError(`policy needs ${requiredApprovals} approvals but lists only ${approvers.length} approvers`);
  }
  return { requiredApprovals, approvers, onExpiry: rule.onExpiry ?? config.onExpiry ?? "expired" };
}

export function approverAllowed(approvers: string[] | null, by: string, aliases: string[] = []): boolean {
  return !approvers || [by, ...aliases].some((name) => approvers.includes(name));
}

export class Nod {
  readonly db: Database;
  readonly baseUrl: string;
  readonly slackWebhook: string | undefined;
  readonly slack: SlackOptions | null;
  readonly config: NodConfig;
  private readonly log: (message: string) => void;

  constructor(options: NodOptions = {}) {
    this.db = new Database(options.path ?? process.env.NOD_DB ?? "nod.db", { create: true });
    this.baseUrl = (options.baseUrl ?? process.env.NOD_URL ?? "http://127.0.0.1:4747").replace(/\/$/, "");
    this.slackWebhook = options.slackWebhook ?? process.env.NOD_SLACK_WEBHOOK;
    const botToken = options.slack?.botToken ?? process.env.NOD_SLACK_BOT_TOKEN;
    const channel = options.slack?.channel ?? process.env.NOD_SLACK_CHANNEL;
    this.slack = botToken && channel
      ? { botToken, channel, apiBase: (options.slack?.apiBase ?? process.env.NOD_SLACK_API ?? "https://slack.com/api").replace(/\/$/, "") }
      : null;
    this.config = loadConfig(options.config);
    this.log = options.log ?? ((message) => console.error(message));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      amount REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT,
      token_hash TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      executed INTEGER NOT NULL DEFAULT 0,
      executed_at INTEGER,
      run_started_at INTEGER,
      run_attempts INTEGER NOT NULL DEFAULT 0,
      result TEXT
    )`);
    const columns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(requests)").all().map((c) => c.name));
    const added: [string, string][] = [
      ["reason", "TEXT"],
      ["required_approvals", "INTEGER NOT NULL DEFAULT 1"],
      ["approvers", "TEXT"],
      ["on_expiry", "TEXT NOT NULL DEFAULT 'expired'"],
      ["slack_channel", "TEXT"],
      ["slack_ts", "TEXT"],
      ["slack_stale", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, type] of added) if (!columns.has(name)) this.db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS votes (
      request_id TEXT NOT NULL,
      approver TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      at INTEGER NOT NULL,
      PRIMARY KEY (request_id, approver)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS links (
      token_hash TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      approver TEXT
    )`);
    this.db.exec(`INSERT OR IGNORE INTO links (token_hash, request_id, approver)
      SELECT token_hash, id, NULL FROM requests WHERE token_hash IS NOT NULL AND status = 'pending'`);
    this.db.exec("UPDATE requests SET token_hash = NULL WHERE token_hash IS NOT NULL");
  }

  async request(input: RequestInput): Promise<{ id: string; link: string | null; links: Record<string, string> }> {
    if (!input.action || !input.summary) throw new NodError("action and summary are required");
    if (input.amount !== undefined && !Number.isFinite(input.amount)) throw new NodError("amount must be a number");
    const amount = input.amount ?? null;
    const policy = resolvePolicy(this.config, { action: input.action, amount });
    const id = randomId("r_", 5);
    const now = Date.now();
    const expiresAt = now + parseDuration(input.expiresIn ?? "24h");
    this.db
      .query(
        `INSERT INTO requests (id, action, summary, amount, currency, payload, created_at, expires_at, idempotency_key,
           required_approvals, approvers, on_expiry)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .run(
        id,
        input.action,
        input.summary,
        amount,
        (input.currency ?? "USD").toUpperCase(),
        JSON.stringify(input.payload ?? null),
        now,
        expiresAt,
        randomId("nod_", 16),
        policy.requiredApprovals,
        policy.approvers ? JSON.stringify(policy.approvers) : null,
        policy.onExpiry,
      );
    const links: Record<string, string> = {};
    if (policy.approvers) for (const approver of policy.approvers) links[approver] = this.issueLink(id, approver);
    const link = policy.approvers ? null : this.issueLink(id, null);
    await this.notify(this.get(id)!, link);
    return { id, link, links };
  }

  private sweep(id?: string): string[] {
    const now = Date.now();
    const expired = this.db
      .query<{ id: string; on_expiry: string }, [number, string | null]>(
        `SELECT id, on_expiry FROM requests WHERE status = 'pending' AND expires_at <= ?1 AND (?2 IS NULL OR id = ?2)`,
      )
      .all(now, id ?? null);
    for (const row of expired) {
      const denied = row.on_expiry === "denied";
      this.db
        .query(
          `UPDATE requests SET status = ?2, decided_at = ?3, decided_by = ?4, reason = ?5, slack_stale = (slack_ts IS NOT NULL)
           WHERE id = ?1 AND status = 'pending'`,
        )
        .run(row.id, denied ? "denied" : "expired", now, denied ? "nod:expiry" : null, "expired before enough approvals");
      this.db.query("DELETE FROM links WHERE request_id = ?1").run(row.id);
    }
    return expired.map((row) => row.id);
  }

  async sweepExpired(): Promise<string[]> {
    this.sweep();
    const stale = this.db.query<{ id: string }, []>("SELECT id FROM requests WHERE slack_stale = 1").all();
    for (const { id } of stale) {
      await this.refreshSlack(this.get(id)!);
      this.db.query("UPDATE requests SET slack_stale = 0 WHERE id = ?1").run(id);
    }
    return stale.map((row) => row.id);
  }

  private toRequest(row: Row): NodRequest {
    const votes = this.db
      .query<Vote, [string]>("SELECT approver, decision, reason, at FROM votes WHERE request_id = ?1 ORDER BY at, rowid")
      .all(row.id);
    return {
      id: row.id,
      action: row.action,
      summary: row.summary,
      amount: row.amount,
      currency: row.currency,
      payload: JSON.parse(row.payload),
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      reason: row.reason,
      requiredApprovals: row.required_approvals,
      approvers: row.approvers ? JSON.parse(row.approvers) : null,
      onExpiry: row.on_expiry,
      votes,
      idempotencyKey: row.idempotency_key,
      executed: row.executed === 1,
      executedAt: row.executed_at,
      runAttempts: row.run_attempts,
      result: row.result === null ? null : JSON.parse(row.result),
      slack: row.slack_channel && row.slack_ts ? { channel: row.slack_channel, ts: row.slack_ts } : null,
    };
  }

  get(id: string): NodRequest | null {
    this.sweep(id);
    const row = this.db.query<Row, [string]>("SELECT * FROM requests WHERE id = ?1").get(id);
    return row ? this.toRequest(row) : null;
  }

  list(options: { all?: boolean; limit?: number } = {}): NodRequest[] {
    this.sweep();
    const where = options.all ? "" : "WHERE status = 'pending' OR (status = 'approved' AND executed = 0)";
    return this.db
      .query<Row, [number]>(`SELECT * FROM requests ${where} ORDER BY created_at DESC LIMIT ?1`)
      .all(options.limit ?? 50)
      .map((row) => this.toRequest(row));
  }

  linkApprover(id: string, token: string): { valid: boolean; approver: string | null } {
    const row = this.db
      .query<{ approver: string | null }, [string, string]>("SELECT approver FROM links WHERE token_hash = ?1 AND request_id = ?2")
      .get(hashToken(token), id);
    return row ? { valid: true, approver: row.approver } : { valid: false, approver: null };
  }

  checkToken(id: string, token: string): boolean {
    return this.linkApprover(id, token).valid;
  }

  decide(id: string, decision: Decision, options: DecideOptions & { aliases?: string[] }): DecideResult {
    return this.db.transaction((): DecideResult => {
      const request = this.get(id);
      if (!request) return { ok: false, reason: "not_found", request: null };
      if (request.status !== "pending") return { ok: false, reason: `already_${request.status}`, request };
      let by = options.by;
      if (options.token !== undefined) {
        const link = this.linkApprover(id, options.token);
        if (!link.valid) return { ok: false, reason: "invalid_token", request };
        if (link.approver) by = link.approver;
      }
      if (!by) return { ok: false, reason: "approver_required", request };
      if (!approverAllowed(request.approvers, by, options.aliases)) return { ok: false, reason: "not_an_approver", request };
      if (request.votes.some((vote) => vote.approver === by)) return { ok: false, reason: "already_voted", request };
      const reason = options.reason?.trim() ? options.reason.trim().slice(0, 1000) : null;
      const now = Date.now();
      this.db
        .query("INSERT INTO votes (request_id, approver, decision, reason, at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .run(id, by, decision, reason, now);
      if (options.token !== undefined) this.db.query("DELETE FROM links WHERE token_hash = ?1").run(hashToken(options.token));
      const approvals = request.votes.filter((vote) => vote.decision === "approved").length + (decision === "approved" ? 1 : 0);
      if (decision === "denied" || approvals >= request.requiredApprovals) {
        const deciders = decision === "denied" ? [by] : [...request.votes.filter((vote) => vote.decision === "approved").map((vote) => vote.approver), by];
        const reasons = decision === "denied" ? [reason] : [...request.votes.map((vote) => vote.reason), reason];
        this.db
          .query("UPDATE requests SET status = ?2, decided_at = ?3, decided_by = ?4, reason = ?5 WHERE id = ?1 AND status = 'pending'")
          .run(id, decision, now, deciders.join(", "), reasons.filter(Boolean).join(" / ") || null);
        this.db.query("DELETE FROM links WHERE request_id = ?1").run(id);
      }
      return { ok: true, request: this.get(id)! };
    }).immediate();
  }

  async decideAndNotify(id: string, decision: Decision, options: DecideOptions & { aliases?: string[] }): Promise<DecideResult> {
    const result = this.decide(id, decision, options);
    if (result.ok) await this.refreshSlack(result.request);
    return result;
  }

  approve(id: string, options: DecideOptions): DecideResult {
    return this.decide(id, "approved", options);
  }

  deny(id: string, options: DecideOptions): DecideResult {
    return this.decide(id, "denied", options);
  }

  newLink(id: string, approver?: string): string {
    const request = this.get(id);
    if (!request || request.status !== "pending") throw new NodError(`request ${id} is not pending`);
    if (request.approvers && !approver) throw new NodError(`request ${id} needs --for, one of: ${request.approvers.join(", ")}`);
    if (approver && !approverAllowed(request.approvers, approver)) throw new NodError(`${approver} is not an approver for ${id}`);
    this.db.query("DELETE FROM links WHERE request_id = ?1 AND approver IS ?2").run(id, approver ?? null);
    return this.issueLink(id, approver ?? null);
  }

  async waitFor(id: string, options: { pollMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Exclude<Status, "pending">> {
    const started = Date.now();
    for (;;) {
      const request = this.get(id);
      if (!request) throw new NodError(`no request ${id}`);
      if (request.status !== "pending") return request.status;
      if (options.signal?.aborted) throw new NodError("wait aborted");
      if (options.timeoutMs !== undefined && Date.now() - started >= options.timeoutMs) {
        throw new NodError(`still pending after ${options.timeoutMs}ms`);
      }
      await Bun.sleep(options.pollMs ?? 500);
    }
  }

  async run<T>(id: string, fn: (context: RunContext) => T | Promise<T>, options: { leaseMs?: number } = {}): Promise<RunOutcome<T>> {
    const request = this.get(id);
    if (!request) throw new NodError(`no request ${id}`);
    if (request.executed) return { ran: false, reason: "already_executed", result: request.result as T };
    if (request.status !== "approved") throw new NodError(`request ${id} is ${request.status}, not approved`);
    const now = Date.now();
    const claimed = this.db
      .query(
        `UPDATE requests SET run_started_at = ?2, run_attempts = run_attempts + 1
         WHERE id = ?1 AND status = 'approved' AND executed = 0
           AND (run_started_at IS NULL OR run_started_at <= ?3)`,
      )
      .run(id, now, now - (options.leaseMs ?? 60_000)).changes;
    if (!claimed) {
      const latest = this.get(id)!;
      if (latest.executed) return { ran: false, reason: "already_executed", result: latest.result as T };
      throw new NodError(`request ${id} is already running in another process`);
    }
    const claim = this.get(id)!;
    let result: T;
    try {
      result = await fn({
        id,
        idempotencyKey: claim.idempotencyKey,
        action: claim.action,
        amount: claim.amount,
        currency: claim.currency,
        payload: claim.payload,
        attempt: claim.runAttempts,
      });
    } catch (error) {
      this.db.query("UPDATE requests SET run_started_at = NULL WHERE id = ?1 AND executed = 0").run(id);
      throw error;
    }
    this.db
      .query("UPDATE requests SET executed = 1, executed_at = ?2, result = ?3, run_started_at = NULL WHERE id = ?1")
      .run(id, Date.now(), JSON.stringify(result ?? null));
    return { ran: true, result };
  }

  close(): void {
    this.db.close();
  }

  private issueLink(id: string, approver: string | null): string {
    const token = randomId("", 24);
    this.db.query("INSERT INTO links (token_hash, request_id, approver) VALUES (?1, ?2, ?3)").run(hashToken(token), id, approver);
    return `${this.baseUrl}/r/${id}?t=${token}`;
  }

  private async refreshSlack(request: NodRequest): Promise<void> {
    if (!this.slack || !request.slack) return;
    const error = await slackUpdate(this.slack, request.slack, request);
    if (error) this.log(`nod: slack update failed: ${error}`);
  }

  private async notify(request: NodRequest, link: string | null): Promise<void> {
    if (this.slack) {
      const posted = await slackPost(this.slack, request, link);
      if ("error" in posted) this.log(`nod: slack post failed: ${posted.error}`);
      else this.db.query("UPDATE requests SET slack_channel = ?2, slack_ts = ?3 WHERE id = ?1").run(request.id, posted.channel, posted.ts);
    }
    if (!this.slackWebhook) return;
    const amount = formatAmount(request);
    const where = link ? `<${link}|Review and decide>` : `Approvers: ${request.approvers?.join(", ")} (each gets a personal link)`;
    const text = `*Approval needed* · ${request.action}${amount ? ` · ${amount}` : ""}\n${request.summary}\n${where}`;
    try {
      const response = await fetch(this.slackWebhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) this.log(`nod: slack webhook answered ${response.status}`);
    } catch (error) {
      this.log(`nod: slack webhook failed: ${(error as Error).message}`);
    }
  }
}
