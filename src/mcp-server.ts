import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Gate } from "./gate.ts";
import { mockChain, testnetChain, type Chain } from "./near.ts";
import { loadPolicyFile } from "./policy.ts";
import { walletTools, type ToolResult } from "./tools.ts";

const out = (r: ToolResult) => ({ content: [{ type: "text" as const, text: r.text }], isError: !r.ok });

export function createServer(gate: Gate, chain: Chain) {
  const t = walletTools(gate, chain);
  const s = new McpServer({ name: "warden-near", version: "0.1.0" });
  const args = z.record(z.string(), z.unknown()).optional();
  s.registerTool("near_get_balance", { description: "Balance in NEAR of the agent's wallet (or another account).", inputSchema: { account_id: z.string().optional() } }, async (a) => out(await t.near_get_balance(a)));
  s.registerTool("near_view", { description: "Read-only contract view call.", inputSchema: { contract_id: z.string(), method: z.string(), args } }, async (a) => out(await t.near_view(a)));
  s.registerTool("near_transfer", { description: "Send NEAR. Policy-gated: per-call cap, daily cap, recipient allowlist, human approval for large amounts.", inputSchema: { receiver_id: z.string(), amount_near: z.string().describe('decimal NEAR, e.g. "0.25"'), approval_id: z.string().optional() } }, async (a) => out(await t.near_transfer(a)));
  s.registerTool("near_call_contract", { description: "Call a contract method. Policy-gated: contract allowlist, caps on attached deposit.", inputSchema: { contract_id: z.string(), method: z.string(), args, deposit_near: z.string().optional(), approval_id: z.string().optional() } }, async (a) => out(await t.near_call_contract(a)));
  return s;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chain = process.env.WARDEN_NEAR_MOCK ? mockChain() : testnetChain();
  const gate = new Gate(loadPolicyFile(process.env.WARDEN_NEAR_POLICY ?? "policy/near-policy.json"), process.env.WARDEN_NEAR_LEDGER ?? ".warden/ledger.json", process.env.WARDEN_NEAR_AGENT ?? "agent");
  await createServer(gate, chain).connect(new StdioServerTransport());
}
