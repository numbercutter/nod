import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Nod, serveApprovals, slackSignature } from "../src";

const calls: { method: string; body: any }[] = [];
const ephemeral: string[] = [];
const slackApi = Bun.serve({
  port: 0,
  routes: {
    "/api/:method": {
      POST: async (request) => {
        calls.push({ method: request.params.method, body: await request.json() });
        return Response.json({ ok: true, channel: "C0APPROVALS", ts: "1764000000.000100" });
      },
    },
    "/respond": {
      POST: async (request) => {
        ephemeral.push(((await request.json()) as any).text);
        return new Response("ok");
      },
    },
  },
});

const secret = "example-signing-secret";
const dir = mkdtempSync(join(tmpdir(), "nod-slack-"));
const nod = new Nod({
  path: join(dir, "nod.db"),
  config: { rules: [{ action: "deploy.*", approvals: 2, approvers: ["slack:alice", "slack:bob"] }] },
  slack: { botToken: "offline-bot-token", channel: "#approvals", apiBase: `${slackApi.url.origin}/api` },
  log: (message) => console.log(`  log: ${message}`),
});
const server = serveApprovals({ nod, port: 0, slackSigningSecret: secret });
const actions = `${server.url.origin}/slack/actions`;

function texts(blocks: any[]): string {
  return blocks.flatMap((block) => [block.text?.text, ...(block.elements ?? []).map((e: any) => e.text?.text ?? e.text)]).filter(Boolean).join(" | ").replace(/\n/g, " ");
}

async function press(user: { id: string; username: string }, button: "nod_approve" | "nod_deny", id: string, sign: { secret?: string; age?: number } = {}) {
  const payload = {
    type: "block_actions",
    user,
    actions: [{ action_id: button, value: id }],
    container: { channel_id: "C0APPROVALS", message_ts: "1764000000.000100" },
    response_url: `${slackApi.url.origin}/respond`,
  };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000) - (sign.age ?? 0));
  const response = await fetch(actions, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": slackSignature(sign.secret ?? secret, timestamp, body),
    },
    body,
  });
  return { status: response.status, body: (await response.json()) as any };
}

console.log("1. an agent asks to deploy; nod posts Block Kit buttons");
const { id } = await nod.request({ action: "deploy.production", summary: "Deploy api v2.14.0 to production", payload: { sha: "4be1c09" } });
const post = calls.find((call) => call.method === "chat.postMessage")!;
console.log(`  chat.postMessage to ${post.body.channel}: ${texts(post.body.blocks)}`);

console.log("\n2. forged and replayed button presses are refused");
const forged = await press({ id: "U01", username: "alice" }, "nod_approve", id, { secret: "not-the-secret" });
console.log(`  wrong signing secret      -> ${forged.status} ${forged.body.error}`);
const stale = await press({ id: "U01", username: "alice" }, "nod_approve", id, { age: 301 });
console.log(`  timestamp 301s old        -> ${stale.status} ${stale.body.error}`);
console.log(`  status still ${nod.get(id)!.status}, ${nod.get(id)!.votes.length} votes`);

console.log("\n3. signed presses are recorded and the message is updated");
const alice = await press({ id: "U01", username: "alice" }, "nod_approve", id);
console.log(`  alice approves            -> ${alice.status} ${alice.body.status}`);
const mallory = await press({ id: "U09", username: "mallory" }, "nod_approve", id);
console.log(`  mallory approves          -> ${mallory.status} ${mallory.body.reason}; ephemeral reply "${ephemeral.at(-1)}"`);
const again = await press({ id: "U01", username: "alice" }, "nod_approve", id);
console.log(`  alice presses again       -> ${again.status} ${again.body.reason}`);
const bob = await press({ id: "U02", username: "bob" }, "nod_approve", id, { age: 290 });
console.log(`  bob approves (290s old)   -> ${bob.status} ${bob.body.status}`);

const updates = calls.filter((call) => call.method === "chat.update");
console.log(`\n  chat.update calls: ${updates.length}`);
for (const update of updates) console.log(`  - ${texts(update.body.blocks)}`);
console.log(`\n  final: ${nod.get(id)!.status} by ${nod.get(id)!.decidedBy}`);

server.stop(true);
slackApi.stop(true);
nod.close();
rmSync(dir, { recursive: true, force: true });
