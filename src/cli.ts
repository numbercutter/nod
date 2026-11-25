#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { userInfo } from "node:os";
import { Nod, NodError, formatAmount, type NodRequest } from "./nod";
import { serveApprovals } from "./server";

const usage = `nod: durable human approval for risky agent actions

usage:
  nod serve [--port 4747] [--host 127.0.0.1]   approval pages at /r/<id>, Slack buttons at /slack/actions
  nod list [--all]                             pending and approved-but-not-run requests
  nod show <id>                                full record as JSON
  nod approve <id> [--by NAME] [--reason TEXT]
  nod deny <id> [--by NAME] [--reason TEXT]
  nod link <id> [--for APPROVER]               issue a fresh one-time approval link

options:
  --db PATH       database file (default $NOD_DB or nod.db)
  --config PATH   policy file (default $NOD_CONFIG or nod.config.json)`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    db: { type: "string" },
    config: { type: "string" },
    reason: { type: "string" },
    for: { type: "string" },
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
  const approvals = r.votes.filter((vote) => vote.decision === "approved").length;
  const state = r.executed ? `${r.status}, ran` : r.status === "pending" && r.requiredApprovals > 1 ? `pending ${approvals}/${r.requiredApprovals}` : r.status;
  return `${r.id}  ${state.padEnd(13)} ${r.action.padEnd(22)} ${formatAmount(r).padStart(12)}  ${r.summary}`;
}

function voteLines(r: NodRequest): string[] {
  return r.votes.map((vote) => `  ${vote.decision.padEnd(8)} ${vote.approver}${vote.reason ? `: ${vote.reason}` : ""}`);
}

if (!command || values.help) {
  console.log(usage);
  process.exit(command ? 0 : 1);
}

const nod = new Nod({ path: values.db, config: values.config });
const by = values.by ?? `cli:${userInfo().username}`;

try {
  switch (command) {
    case "serve": {
      const server = serveApprovals({ nod, port: values.port ? Number(values.port) : undefined, hostname: values.host });
      console.log(`nod approvals on ${server.url}`);
      if (nod.slack) console.log(`slack: posting to ${nod.slack.channel}; buttons ${process.env.NOD_SLACK_SIGNING_SECRET ? "answered" : "refused (set NOD_SLACK_SIGNING_SECRET)"} at ${server.url}slack/actions`);
      if (server.url.origin !== new URL(nod.baseUrl).origin) {
        console.log(`note: links are built from NOD_URL=${nod.baseUrl}; set NOD_URL=${server.url.origin} to match`);
      }
      break;
    }
    case "list": {
      const rows = nod.list({ all: values.all });
      if (!rows.length) console.log(values.all ? "no requests" : "nothing waiting");
      for (const row of rows) {
        console.log(line(row));
        for (const vote of voteLines(row)) console.log(vote);
      }
      break;
    }
    case "show": {
      const record = nod.get(id ?? fail("show needs an id")) ?? fail(`no request ${id}`);
      console.log(JSON.stringify(record, null, 2));
      break;
    }
    case "approve":
    case "deny": {
      const result = await nod.decideAndNotify(id ?? fail(`${command} needs an id`), command === "approve" ? "approved" : "denied", { by, reason: values.reason });
      if (!result.ok) fail(`${id}: ${result.reason}`);
      console.log(line(result.request));
      for (const vote of voteLines(result.request)) console.log(vote);
      break;
    }
    case "link": {
      console.log(nod.newLink(id ?? fail("link needs an id"), values.for));
      break;
    }
    default:
      fail(`unknown command "${command}"\n\n${usage}`);
  }
} catch (error) {
  if (error instanceof NodError) fail(error.message);
  throw error;
}
