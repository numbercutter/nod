#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { userInfo } from "node:os";
import { Nod, NodError, formatAmount, type NodRequest } from "./nod";
import { serveApprovals } from "./server";

const usage = `nod: durable human approval for risky agent actions

usage:
  nod serve [--port 4747] [--host 127.0.0.1]   approval pages at /r/<id>
  nod list [--all]                             pending and approved-but-not-run requests
  nod show <id>                                full record as JSON
  nod approve <id> [--by NAME]
  nod deny <id> [--by NAME]
  nod link <id>                                issue a fresh one-time approval link

options:
  --db PATH   database file (default $NOD_DB or nod.db)`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    db: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    by: { type: "string" },
    all: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, id] = positionals;

function fail(message: string): never {
  console.error(`nod: ${message}`);
  process.exit(1);
}

function line(r: NodRequest): string {
  const state = r.executed ? `${r.status}, ran` : r.status;
  return `${r.id}  ${state.padEnd(13)} ${r.action.padEnd(22)} ${formatAmount(r).padStart(12)}  ${r.summary}`;
}

if (!command || values.help) {
  console.log(usage);
  process.exit(command ? 0 : 1);
}

const nod = new Nod({ path: values.db });
const by = values.by ?? `cli:${userInfo().username}`;

try {
  switch (command) {
    case "serve": {
      const server = serveApprovals({ nod, port: values.port ? Number(values.port) : undefined, hostname: values.host });
      console.log(`nod approvals on ${server.url}`);
      if (server.url.origin !== new URL(nod.baseUrl).origin) {
        console.log(`note: links are built from NOD_URL=${nod.baseUrl}; set NOD_URL=${server.url.origin} to match`);
      }
      break;
    }
    case "list": {
      const rows = nod.list({ all: values.all });
      if (!rows.length) console.log(values.all ? "no requests" : "nothing waiting");
      for (const row of rows) console.log(line(row));
      break;
    }
    case "show": {
      const record = nod.get(id ?? fail("show needs an id")) ?? fail(`no request ${id}`);
      console.log(JSON.stringify(record, null, 2));
      break;
    }
    case "approve":
    case "deny": {
      const result = nod.decide(id ?? fail(`${command} needs an id`), command === "approve" ? "approved" : "denied", { by });
      if (!result.ok) fail(`${id}: ${result.reason}`);
      console.log(line(result.request));
      break;
    }
    case "link": {
      console.log(nod.newLink(id ?? fail("link needs an id")));
      break;
    }
    default:
      fail(`unknown command "${command}"\n\n${usage}`);
  }
} catch (error) {
  if (error instanceof NodError) fail(error.message);
  throw error;
}
