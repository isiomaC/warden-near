import type { Gate } from "./gate.ts";
import type { Chain } from "./near.ts";
import { formatNear, toYocto } from "./units.ts";

export type ToolResult = { ok: boolean; text: string };

/** The four wallet tools. Each one asks the Gate first; the chain is only touched on ALLOW. */
export function walletTools(gate: Gate, chain: Chain) {
  const guarded = async (tool: string, params: Record<string, unknown>, resource: { amountYocto: string; contract?: string; receiver?: string }, run: () => Promise<Record<string, unknown>>, approvalId?: string): Promise<ToolResult> => {
    // decide + execute run as one critical section per gate: the ALLOW (spend reservation) is in the ledger before the next call is evaluated.
    return gate.exclusive(async () => {
      const v = await gate.decide(tool, params, resource, approvalId);
      if (v.effect === "DENY") return { ok: false, text: `DENIED by Warden: ${v.reason || "no matching rule (default deny)"}` };
      if (v.effect === "PENDING_APPROVAL") return { ok: false, text: `PENDING_APPROVAL ${v.approvalId}: a human must run \`pnpm approve ${v.approvalId}\`, then retry this exact call with approval_id.` };
      try {
        const out = await run();
        gate.recordExecution(tool, out);
        return { ok: true, text: JSON.stringify(out) };
      } catch (e) {
        // The reservation is NOT released: the ALLOW stays counted against the daily cap (conservative, see README).
        gate.recordExecution(tool, { error: (e as Error).message });
        return { ok: false, text: `execution failed: ${(e as Error).message}` };
      }
    });
  };
  const bad = (tool: string, params: Record<string, unknown>, e: unknown): Promise<ToolResult> => {
    const { approval_id, ...p } = params;
    return gate.exclusive(async () => gate.recordInvalid(tool, p, (e as Error).message)).then(() => ({ ok: false, text: `invalid input: ${(e as Error).message}` }));
  };

  return {
    near_get_balance: (a: { account_id?: string }) =>
      guarded("near_get_balance", a, { amountYocto: "0" }, async () => ({ account: a.account_id ?? chain.accountId, balance_near: formatNear(await chain.getBalance(a.account_id)) })),
    near_view: (a: { contract_id: string; method: string; args?: Record<string, unknown> }) =>
      guarded("near_view", a, { amountYocto: "0", contract: a.contract_id }, async () => ({ result: await chain.view(a.contract_id, a.method, a.args ?? {}) })),
    near_transfer: async (a: { receiver_id: string; amount_near: string; approval_id?: string }) => {
      let y: bigint;
      try { y = toYocto(a.amount_near); } catch (e) { return bad("near_transfer", a, e); }
      const { approval_id, ...params } = a;
      return guarded("near_transfer", params, { amountYocto: y.toString(), receiver: a.receiver_id }, async () => ({ ...(await chain.transfer(a.receiver_id, y)), receiver: a.receiver_id, amount_near: a.amount_near }), approval_id);
    },
    near_call_contract: async (a: { contract_id: string; method: string; args?: Record<string, unknown>; deposit_near?: string; approval_id?: string }) => {
      let y: bigint;
      try { y = toYocto(a.deposit_near ?? "0"); } catch (e) { return bad("near_call_contract", a, e); }
      const { approval_id, ...params } = a;
      return guarded("near_call_contract", params, { amountYocto: y.toString(), contract: a.contract_id }, async () => ({ ...(await chain.call(a.contract_id, a.method, a.args ?? {}, y)), contract: a.contract_id, method: a.method }), approval_id);
    },
  };
}
