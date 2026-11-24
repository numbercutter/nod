<p align="center"><img src="assets/banner.svg" alt="nod" width="100%"></p>

**Nothing big happens without a nod.**

nod holds a risky agent action until a person approves it, then runs it once. Requests live in SQLite, so the agent can crash, restart or hand off to another process, and the approval and the "already done" record are still there.

## Quick start

Needs [Bun](https://bun.sh) 1.1 or newer. No accounts, no API keys.

```sh
git clone https://github.com/numbercutter/nod && cd nod
bun examples/request.ts                       # process A asks for a $50k purchase order, then exits
bun src/cli.ts approve $(cat examples/.last-id)
bun examples/execute.ts                       # process B, fresh: sees the approval, places the order
bun examples/execute.ts                       # run it again: nothing happens twice
```

```
decision: approved
placing order: 400 x ENC-220-AL from Halden Metals, $50000
done, PO-42AFE8
orders.log has 1 line(s)
...
decision: approved
already executed earlier (PO-42AFE8), not running again
orders.log has 1 line(s)
```

To approve in a browser instead, run `bun src/cli.ts serve` in another terminal before `examples/request.ts` and open the link it prints.

## Usage

```ts
import { Nod } from "@numbercutter/nod";

const nod = new Nod({ path: "nod.db" });

const { id, link } = await nod.request({
  action: "purchase_order.create",
  summary: "Order 400 aluminium enclosures from Halden Metals",
  amount: 50_000,
  payload: { vendor: "Halden Metals", sku: "ENC-220-AL", quantity: 400 },
  expiresIn: "2d",
});

const status = await nod.waitFor(id);          // "approved" | "denied" | "expired"

if (status === "approved") {
  const outcome = await nod.run(id, async ({ idempotencyKey, payload }) => {
    return placeOrder(payload, { idempotencyKey });
  });
  // outcome.ran is false if this request already ran, with the stored result
}
```

`expiresIn` takes seconds or `30m`, `4h`, `2d` (default 24h). The function you pass to `run` gets the payload, the amount and a stable `idempotencyKey`; pass that key to the API you call.

### Approvers

- **Browser.** `nod serve` serves `GET /r/:id?t=<token>` with the summary, amount, payload and Approve / Deny buttons. The token is single use and only its hash is stored. Opening the link does not decide anything, so link previews are harmless.
- **Slack.** Set `NOD_SLACK_WEBHOOK` to an incoming webhook URL and each new request posts its summary and link there.
- **CLI.** Anyone with access to the database file can decide.

```sh
bun src/cli.ts serve --port 4747     # set NOD_URL if links should use another address
bun src/cli.ts list                  # pending, and approved but not run yet
bun src/cli.ts list --all
bun src/cli.ts show <id>
bun src/cli.ts approve <id> --by sam
bun src/cli.ts deny <id> --by sam
bun src/cli.ts link <id>             # fresh one-time link if the first one is lost
```

| env | default | |
|---|---|---|
| `NOD_DB` | `nod.db` | database file |
| `NOD_URL` | `http://127.0.0.1:4747` | base for approval links |
| `NOD_SLACK_WEBHOOK` | unset | Slack incoming webhook |

## How it works

Each request is one SQLite row: status, expiry, approver, a hashed one-time token, an idempotency key, an `executed` flag and the stored result. Decisions are a conditional update inside an immediate transaction, so only the first approve or deny counts.

`run` claims the row with a conditional update before calling your function, marks it executed with the result afterwards, and releases the claim if your function throws. A second caller, in any process, gets the stored result instead of a second run. If a process dies inside your function, the claim is retried after a lease (60 s by default) with the same idempotency key and `attempt` incremented.

## Limits

- Exactly once is guaranteed for nod's own record, not for the outside world. If a process dies after the external call but before nod records it, the retry calls again with the same idempotency key. The API you call has to honour that key.
- Single machine. SQLite in WAL mode handles several local processes; it is not a shared store across hosts.
- Approval links carry their token in the URL. Anyone holding the link can decide until it is used or expires.
- `nod serve` has no login. It binds to `127.0.0.1`; put it behind your own auth before exposing it.
- `waitFor` polls the database (500 ms by default) rather than being pushed.
- Slack messages are sent once, without retries, and carry a link rather than interactive buttons.

<sub>A numbercutter instrument · MIT</sub>
