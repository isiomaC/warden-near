import { readFileSync } from "node:fs";
import { createWarden, definePolicy, type AuditEntry, type AuthorizationPolicy, type WardenExtension } from "@stlw/warden";
import { z } from "zod";
import { toYocto } from "./units.ts";

export const PolicyFile = z.object({
  name: z.string(),
  version: z.number().int().min(1),
  perCallNear: z.string(),
  dailyNear: z.string(),
  approvalAboveNear: z.string(),
  allowedContracts: z.array(z.string()),
  allowedRecipients: z.array(z.string()),
});
export type PolicyFile = z.infer<typeof PolicyFile>;

export const loadPolicyFile = (path: string): PolicyFile => PolicyFile.parse(JSON.parse(readFileSync(path, "utf8")));

export const SPEND_TOOLS = ["near_transfer", "near_call_contract"];
export const READ_TOOLS = ["near_get_balance", "near_view"];
export const DAY_MS = 24 * 3600 * 1000;

/** What a tool call is, as seen by the policy engine. Plain data only (Warden rejects bigint). */
export type Resource = { amountYocto: string; contract?: string; receiver?: string };

const res = (r: { resource: unknown }) => r.resource as Resource;
const amount = (r: { resource: unknown }) => BigInt(res(r).amountYocto);

/**
 * Spend already allowed in the last 24h, read from the ledger itself, so the daily cap cannot drift from the record.
 * ponytail: counts a spend when it is allowed, not when it lands, so a failed transaction still uses cap. Conservative.
 */
export const spentLast24h = (entries: readonly AuditEntry[], now = Date.now()): bigint =>
  entries.reduce((sum, e) => {
    const p = e.event.payload as { effect?: string; amountYocto?: string };
    if (e.event.eventType !== "near.decision" || p.effect !== "ALLOW") return sum;
    if (now - Date.parse(e.event.occurredAt) > DAY_MS) return sum;
    return sum + BigInt(p.amountYocto ?? "0");
  }, 0n);

export function wardenFor(getEntries: () => readonly AuditEntry[], now: () => number = Date.now) {
  const ext: WardenExtension = {
    name: "warden-near",
    version: "0.1.0",
    resolvers: [{ name: "ledger", resolve: () => spentLast24h(getEntries(), now()).toString() }],
    conditions: [
      { name: "toolIn", evaluate: (r, v) => (v as string[]).includes(r.action as string) },
      { name: "amountGtNear", evaluate: (r, v) => amount(r) > toYocto(v as string) },
      { name: "amountLteNear", evaluate: (r, v) => amount(r) <= toYocto(v as string) },
      { name: "contractNotIn", evaluate: (r, v) => !(v as string[]).includes(res(r).contract ?? "") },
      { name: "contractIn", evaluate: (r, v) => (v as string[]).includes(res(r).contract ?? "") },
      { name: "receiverNotIn", evaluate: (r, v) => !(v as string[]).includes(res(r).receiver ?? "") },
      { name: "receiverIn", evaluate: (r, v) => (v as string[]).includes(res(r).receiver ?? "") },
      // resolved = yocto already spent in the last 24h (from the ledger); true when this call would pass the daily cap
      { name: "wouldExceedDaily", evaluate: (r, v, resolved) => BigInt(resolved as string) + amount(r) > toYocto(v as string) },
    ],
  };
  return createWarden({ extensions: [ext] });
}

/** Deny wins over PENDING_APPROVAL, which wins over ALLOW; no matching rule is a DENY (Warden's semantics). */
export function buildPolicy(f: PolicyFile): AuthorizationPolicy {
  const spend = { name: "toolIn", value: SPEND_TOOLS };
  return definePolicy({
    id: f.name,
    version: f.version,
    rules: [
      { id: "allow-reads", effect: "ALLOW", conditions: [{ name: "toolIn", value: READ_TOOLS }] },
      { id: "allow-transfer-to-allowlisted", effect: "ALLOW", conditions: [{ name: "toolIn", value: ["near_transfer"] }, { name: "receiverIn", value: f.allowedRecipients }, { name: "amountLteNear", value: f.perCallNear }] },
      { id: "allow-call-to-allowlisted", effect: "ALLOW", conditions: [{ name: "toolIn", value: ["near_call_contract"] }, { name: "contractIn", value: f.allowedContracts }, { name: "amountLteNear", value: f.perCallNear }] },
      { id: "deny-over-per-call-cap", effect: "DENY", conditions: [spend, { name: "amountGtNear", value: f.perCallNear }] },
      { id: "deny-over-daily-cap", effect: "DENY", conditions: [spend, { name: "ledger:wouldExceedDaily", value: f.dailyNear }] },
      { id: "deny-contract-not-allowlisted", effect: "DENY", conditions: [{ name: "toolIn", value: ["near_call_contract"] }, { name: "contractNotIn", value: f.allowedContracts }] },
      { id: "deny-recipient-not-allowlisted", effect: "DENY", conditions: [{ name: "toolIn", value: ["near_transfer"] }, { name: "receiverNotIn", value: f.allowedRecipients }] },
      { id: "approve-large-spend", effect: "PENDING_APPROVAL", conditions: [spend, { name: "amountGtNear", value: f.approvalAboveNear }] },
    ],
  });
}
