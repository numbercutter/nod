import { Nod } from "../src";

const nod = new Nod();

const { id, link, links } = await nod.request({
  action: "purchase_order.create",
  summary: "Order 400 aluminium enclosures from Halden Metals",
  amount: 50_000,
  currency: "USD",
  payload: { vendor: "Halden Metals", sku: "ENC-220-AL", quantity: 400, unitPrice: 125 },
  expiresIn: "2d",
});

await Bun.write(new URL("./.last-id", import.meta.url), id);

console.log(`request ${id} saved, waiting for a human`);
console.log(`approve:  bun src/cli.ts approve ${id}`);
if (link) console.log(`or open:  ${link}  (after bun src/cli.ts serve)`);
for (const [approver, url] of Object.entries(links)) console.log(`${approver}: ${url}`);
console.log("this process now exits; nothing is held in memory");
