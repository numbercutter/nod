import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Nod, type NodConfig } from "../src";

const dir = mkdtempSync(join(tmpdir(), "nod-two-"));
const config: NodConfig = {
  approvers: ["sam", "lee", "kim"],
  onExpiry: "denied",
  rules: [{ action: "payment.*", minAmount: 10_000, approvals: 2, approvers: ["sam", "lee"] }],
};
await Bun.write(join(dir, "nod.config.json"), JSON.stringify(config, null, 2));
const nod = new Nod({ path: join(dir, "nod.db"), config: join(dir, "nod.config.json") });

function show(label: string, result: ReturnType<Nod["decide"]>) {
  const request = result.request!;
  const approvals = request.votes.filter((vote) => vote.decision === "approved").length;
  const verdict = result.ok ? `${request.status} (${approvals}/${request.requiredApprovals})` : `refused: ${result.reason}`;
  console.log(`  ${label.padEnd(32)} -> ${verdict}`);
}

console.log("policy: payment.* of $10,000 or more needs 2 of [sam, lee]; anything else 1 of [sam, lee, kim]; expiry denies\n");

console.log("1. a $48,000 wire");
const wire = await nod.request({ action: "payment.wire", summary: "Wire $48,000 to Halden Metals", amount: 48_000, payload: { iban: "DE89 3704 0044 0532 0130 00" } });
console.log(`  ${wire.id}: each approver gets a personal link (${Object.keys(wire.links).join(", ")})`);
show("sam approves", nod.approve(wire.id, { by: "sam", reason: "matches PO-1182 and the signed quote" }));
show("sam approves again", nod.approve(wire.id, { by: "sam" }));
show("kim approves (not on this rule)", nod.approve(wire.id, { by: "kim" }));
const token = new URL(wire.links.lee).searchParams.get("t")!;
show("lee approves via own link", nod.approve(wire.id, { by: "web", token, reason: "vendor bank details verified by phone" }));
const done = nod.get(wire.id)!;
console.log(`  decided by ${done.decidedBy}`);
console.log(`  reason: ${done.reason}`);
const outcome = await nod.run(wire.id, ({ idempotencyKey }) => ({ wireId: `W-${idempotencyKey.slice(-6).toUpperCase()}` }));
console.log(`  ran: ${outcome.ran}, ${JSON.stringify(outcome.result)}`);

console.log("\n2. a $900 refund needs one approver");
const refund = await nod.request({ action: "payment.refund", summary: "Refund order 5521", amount: 900 });
show("kim denies", nod.deny(refund.id, { by: "kim", reason: "already refunded on 11-20" }));
console.log(`  reason: ${nod.get(refund.id)!.reason}`);

console.log("\n3. a request nobody answers");
const stale = await nod.request({ action: "payment.wire", summary: "Wire $12,000 to Oro Labs", amount: 12_000, expiresIn: 1 });
show("sam approves", nod.approve(stale.id, { by: "sam" }));
await Bun.sleep(1100);
const expired = nod.get(stale.id)!;
console.log(`  after expiry: ${expired.status} by ${expired.decidedBy} (${expired.reason})`);

nod.close();
rmSync(dir, { recursive: true, force: true });
