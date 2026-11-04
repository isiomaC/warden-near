// Scripted "agent" talking to the real MCP server over an in-memory transport.
//   pnpm demo                    offline: mock chain, ledger in .warden/demo-ledger.json
//   pnpm demo -- --testnet       real NEAR testnet transfers + anchor (needs .env from `pnpm setup:testnet`)
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Gate } from "./gate.ts";
import { createServer } from "./mcp-server.ts";
import { mockChain, testnetChain } from "./near.ts";
import { loadPolicyFile } from "./policy.ts";

const live = process.argv.includes("--testnet");
const policy = loadPolicyFile("policy/near-policy.json");
const ledger = live ? "demo/ledger.json" : ".warden/demo-ledger.json";
const payee = policy.allowedRecipients[0]!;
for (const f of [ledger, ledger.replace(/\.json$/, ".approvals.json"), ledger.replace(/\.json$/, ".anchor.json")]) rmSync(f, { force: true });
mkdirSync(".warden", { recursive: true });

const chain = live ? testnetChain() : mockChain();
const gate = new Gate(policy, ledger, "demo-agent");
const [ct, st] = InMemoryTransport.createLinkedPair();
await createServer(gate, chain).connect(st);
const agent = new Client({ name: "demo-agent", version: "0.1.0" });
await agent.connect(ct);

async function call(label: string, name: string, args: Record<string, unknown>) {
  const r = (await agent.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = r.content[0]!.text;
  console.log(`${r.isError ? "BLOCKED" : "ok     "}  ${label.padEnd(44)} ${text.slice(0, 150)}`);
  return text;
}

console.log(`network: ${chain.network}  wallet: ${chain.accountId}\n`);
await call("read balance", "near_get_balance", {});
await call("view anchor contract", "near_view", { contract_id: payee, method: "latest", args: { publisher: chain.accountId, logId: "0".repeat(64) } });
await call("pay 0.1 NEAR to allowlisted vendor", "near_transfer", { receiver_id: payee, amount_near: "0.1" });
await call("pay 0.3 NEAR to unknown account", "near_transfer", { receiver_id: "attacker.testnet", amount_near: "0.3" });
await call("call a non-allowlisted contract", "near_call_contract", { contract_id: "evil.testnet", method: "drain", args: {} });
await call("pay 5 NEAR (over per-call cap of 1)", "near_transfer", { receiver_id: payee, amount_near: "5" });
const pending = await call("pay 0.8 NEAR (needs human approval)", "near_transfer", { receiver_id: payee, amount_near: "0.8" });
const id = /PENDING_APPROVAL (\S+):/.exec(pending)![1]!;
console.log(`        -- human runs: pnpm approve ${id}`);
// a second Gate on the same ledger file, exactly what `pnpm approve` does in another process
new Gate(policy, ledger, "human").resolve(id, "APPROVED", "human");
await call("retry 0.8 NEAR with approval_id", "near_transfer", { receiver_id: payee, amount_near: "0.8", approval_id: id });
await call("pay 0.5 NEAR", "near_transfer", { receiver_id: payee, amount_near: "0.5" });
await call("pay 0.5 NEAR", "near_transfer", { receiver_id: payee, amount_near: "0.5" });
await call("pay 0.5 NEAR (would pass daily cap of 2)", "near_transfer", { receiver_id: payee, amount_near: "0.5" });

console.log(`\nledger: ${ledger} (${gate.entries.length} entries)`);
if (live) {
  execFileSync("node_modules/.bin/tsx", ["--env-file=.env", "src/cli.ts", "anchor", ledger, `demo-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`], { stdio: "inherit" });
  execFileSync("node_modules/.bin/tsx", ["src/cli.ts", "verify", ledger, ledger.replace(/\.json$/, ".anchor.json")], { stdio: "inherit" });
} else {
  console.log("offline run: not anchored. Verify the recorded testnet run instead: pnpm verify demo/ledger.json demo/ledger.anchor.json");
}
process.exit(0);
