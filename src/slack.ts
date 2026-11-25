import { createHmac, timingSafeEqual } from "node:crypto";
import { formatAmount, type NodRequest } from "./nod";

export type SlackOptions = { botToken: string; channel: string; apiBase: string };

export const SLACK_REPLAY_WINDOW = 300;

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function progress(request: NodRequest): string {
  const approvals = request.votes.filter((vote) => vote.decision === "approved");
  const lines = request.votes.map((vote) => `${vote.decision === "approved" ? "approved" : "denied"} by ${escape(vote.approver)}${vote.reason ? `: _${escape(vote.reason)}_` : ""}`);
  if (request.status === "pending" && request.requiredApprovals > 1) lines.unshift(`${approvals.length} of ${request.requiredApprovals} approvals`);
  if (request.status === "expired" || request.decidedBy === "nod:expiry") lines.push(`${request.status} at ${new Date(request.decidedAt ?? Date.now()).toISOString()}: ${request.reason ?? "no decision in time"}`);
  return lines.join("\n");
}

export function slackBlocks(request: NodRequest, link: string | null): unknown[] {
  const amount = formatAmount(request);
  const head = request.status === "pending" ? "*Approval needed*" : `*${request.status[0].toUpperCase()}${request.status.slice(1)}*`;
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `${head} · \`${escape(request.action)}\`${amount ? ` · *${escape(amount)}*` : ""}\n${escape(request.summary)}` } },
  ];
  const context = [`${request.id}`, request.approvers ? `approvers: ${request.approvers.map(escape).join(", ")}` : null].filter(Boolean).join(" · ");
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: context }] });
  const status = progress(request);
  if (status) blocks.push({ type: "section", text: { type: "mrkdwn", text: status } });
  if (request.status === "pending") {
    const elements: unknown[] = [
      { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "nod_approve", value: request.id },
      { type: "button", style: "danger", text: { type: "plain_text", text: "Deny" }, action_id: "nod_deny", value: request.id },
    ];
    if (link) elements.push({ type: "button", text: { type: "plain_text", text: "Details" }, action_id: "nod_open", url: link });
    blocks.push({ type: "actions", block_id: "nod", elements });
  }
  return blocks;
}

function fallback(request: NodRequest): string {
  const amount = formatAmount(request);
  return `${request.status === "pending" ? "Approval needed" : request.status}: ${request.action}${amount ? ` ${amount}` : ""}, ${request.summary}`;
}

async function call(options: SlackOptions, method: string, body: object): Promise<{ ok: boolean; error?: string; channel?: string; ts?: string }> {
  try {
    const response = await fetch(`${options.apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${options.botToken}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return (await response.json()) as { ok: boolean; error?: string };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function slackPost(options: SlackOptions, request: NodRequest, link: string | null): Promise<{ channel: string; ts: string } | { error: string }> {
  const answer = await call(options, "chat.postMessage", { channel: options.channel, text: fallback(request), blocks: slackBlocks(request, link) });
  if (!answer.ok || !answer.channel || !answer.ts) return { error: answer.error ?? "no message ts" };
  return { channel: answer.channel, ts: answer.ts };
}

export async function slackUpdate(options: SlackOptions, where: { channel: string; ts: string }, request: NodRequest): Promise<string | null> {
  const answer = await call(options, "chat.update", { channel: where.channel, ts: where.ts, text: fallback(request), blocks: slackBlocks(request, null) });
  return answer.ok ? null : (answer.error ?? "unknown error");
}

export function slackSignature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

export function verifySlackRequest(secret: string, headers: Headers, body: string, now = Math.floor(Date.now() / 1000)): { ok: true } | { ok: false; reason: string } {
  const timestamp = headers.get("x-slack-request-timestamp") ?? "";
  const signature = headers.get("x-slack-signature") ?? "";
  if (!/^\d+$/.test(timestamp) || !signature) return { ok: false, reason: "missing_signature" };
  if (Math.abs(now - Number(timestamp)) > SLACK_REPLAY_WINDOW) return { ok: false, reason: "stale_timestamp" };
  const expected = Buffer.from(slackSignature(secret, timestamp, body));
  const presented = Buffer.from(signature);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}
