import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Nod } from "../src";

const ledger = new URL("./orders.log", import.meta.url).pathname;
const idFile = new URL("./.last-id", import.meta.url).pathname;
const id = Bun.argv[2] ?? (existsSync(idFile) ? readFileSync(idFile, "utf8").trim() : "");
if (!id) throw new Error("run examples/request.ts first, or pass a request id");

const nod = new Nod();

console.log(`process ${process.pid} resuming ${id}`);
const status = await nod.waitFor(id, { pollMs: 1000 });
console.log(`decision: ${status}`);
if (status !== "approved") process.exit(0);

const outcome = await nod.run(id, ({ idempotencyKey, payload, amount }) => {
  const order = payload as { vendor: string; quantity: number; sku: string };
  console.log(`placing order: ${order.quantity} x ${order.sku} from ${order.vendor}, $${amount}`);
  appendFileSync(ledger, `${new Date().toISOString()} ${idempotencyKey} ${order.sku} x${order.quantity}\n`);
  return { orderNumber: `PO-${idempotencyKey.slice(-6).toUpperCase()}` };
});

if (outcome.ran) console.log(`done, ${outcome.result.orderNumber}`);
else console.log(`already executed earlier (${outcome.result.orderNumber}), not running again`);
console.log(`orders.log has ${readFileSync(ledger, "utf8").trim().split("\n").length} line(s)`);
