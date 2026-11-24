import { Database } from "bun:sqlite";

export type Status = "pending" | "approved" | "denied" | "expired";

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
  idempotencyKey: string;
  executed: boolean;
  executedAt: number | null;
  runAttempts: number;
  result: unknown;
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

export type DecideResult = { ok: true; request: NodRequest } | { ok: false; reason: string; request: NodRequest | null };

export type NodOptions = {
  path?: string;
  baseUrl?: string;
  slackWebhook?: string;
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
  token_hash: string | null;
  idempotency_key: string;
  executed: number;
  executed_at: number | null;
  run_started_at: number | null;
  run_attempts: number;
  result: string | null;
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

function toRequest(row: Row): NodRequest {
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
    idempotencyKey: row.idempotency_key,
    executed: row.executed === 1,
    executedAt: row.executed_at,
    runAttempts: row.run_attempts,
    result: row.result === null ? null : JSON.parse(row.result),
  };
}

export function formatAmount(request: Pick<NodRequest, "amount" | "currency">): string {
  if (request.amount === null) return "";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: request.currency }).format(request.amount);
  } catch {
    return `${request.amount} ${request.currency}`;
  }
}

export class Nod {
  readonly db: Database;
  readonly baseUrl: string;
  readonly slackWebhook: string | undefined;
  private readonly log: (message: string) => void;

  constructor(options: NodOptions = {}) {
    this.db = new Database(options.path ?? process.env.NOD_DB ?? "nod.db", { create: true });
    this.baseUrl = (options.baseUrl ?? process.env.NOD_URL ?? "http://127.0.0.1:4747").replace(/\/$/, "");
    this.slackWebhook = options.slackWebhook ?? process.env.NOD_SLACK_WEBHOOK;
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
  }

  async request(input: RequestInput): Promise<{ id: string; link: string }> {
    if (!input.action || !input.summary) throw new NodError("action and summary are required");
    if (input.amount !== undefined && !Number.isFinite(input.amount)) throw new NodError("amount must be a number");
    const id = randomId("r_", 5);
    const token = randomId("", 24);
    const now = Date.now();
    const expiresAt = now + parseDuration(input.expiresIn ?? "24h");
    this.db
      .query(
        `INSERT INTO requests (id, action, summary, amount, currency, payload, created_at, expires_at, token_hash, idempotency_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .run(
        id,
        input.action,
        input.summary,
        input.amount ?? null,
        (input.currency ?? "USD").toUpperCase(),
        JSON.stringify(input.payload ?? null),
        now,
        expiresAt,
        hashToken(token),
        randomId("nod_", 16),
      );
    const link = this.linkFor(id, token);
    await this.notify(this.get(id)!, link);
    return { id, link };
  }

  get(id: string): NodRequest | null {
    this.db
      .query("UPDATE requests SET status = 'expired', token_hash = NULL WHERE id = ?1 AND status = 'pending' AND expires_at <= ?2")
      .run(id, Date.now());
    const row = this.db.query<Row, [string]>("SELECT * FROM requests WHERE id = ?1").get(id);
    return row ? toRequest(row) : null;
  }

  list(options: { all?: boolean; limit?: number } = {}): NodRequest[] {
    this.db
      .query("UPDATE requests SET status = 'expired', token_hash = NULL WHERE status = 'pending' AND expires_at <= ?1")
      .run(Date.now());
    const where = options.all ? "" : "WHERE status = 'pending' OR (status = 'approved' AND executed = 0)";
    return this.db
      .query<Row, [number]>(`SELECT * FROM requests ${where} ORDER BY created_at DESC LIMIT ?1`)
      .all(options.limit ?? 50)
      .map(toRequest);
  }

  checkToken(id: string, token: string): boolean {
    const row = this.db.query<{ token_hash: string | null }, [string]>("SELECT token_hash FROM requests WHERE id = ?1").get(id);
    return Boolean(row?.token_hash) && row!.token_hash === hashToken(token);
  }

  decide(id: string, decision: Decision, options: { by: string; token?: string }): DecideResult {
    return this.db.transaction((): DecideResult => {
      const request = this.get(id);
      if (!request) return { ok: false, reason: "not_found", request: null };
      if (request.status !== "pending") return { ok: false, reason: `already_${request.status}`, request };
      if (options.token !== undefined && !this.checkToken(id, options.token)) {
        return { ok: false, reason: "invalid_token", request };
      }
      this.db
        .query("UPDATE requests SET status = ?2, decided_at = ?3, decided_by = ?4, token_hash = NULL WHERE id = ?1 AND status = 'pending'")
        .run(id, decision, Date.now(), options.by);
      return { ok: true, request: this.get(id)! };
    }).immediate();
  }

  approve(id: string, options: { by: string; token?: string }): DecideResult {
    return this.decide(id, "approved", options);
  }

  deny(id: string, options: { by: string; token?: string }): DecideResult {
    return this.decide(id, "denied", options);
  }

  newLink(id: string): string {
    const token = randomId("", 24);
    const changed = this.db
      .query("UPDATE requests SET token_hash = ?2 WHERE id = ?1 AND status = 'pending' AND expires_at > ?3")
      .run(id, hashToken(token), Date.now()).changes;
    if (!changed) throw new NodError(`request ${id} is not pending`);
    return this.linkFor(id, token);
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

  private linkFor(id: string, token: string): string {
    return `${this.baseUrl}/r/${id}?t=${token}`;
  }

  private async notify(request: NodRequest, link: string): Promise<void> {
    if (!this.slackWebhook) return;
    const amount = formatAmount(request);
    const text = `*Approval needed* · ${request.action}${amount ? ` · ${amount}` : ""}\n${request.summary}\n<${link}|Review and decide>`;
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
