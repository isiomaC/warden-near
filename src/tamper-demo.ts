// Replays the tamper cases against the recorded testnet run. No network, no key.
import { readFileSync } from "node:fs";
import { createAuditEntry, type AuditEntry } from "@stlw/warden";
import { verifyAgainstAnchor } from "./verify.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const anchor = read("../demo/ledger.anchor.json");
const entries: AuditEntry[] = read("../demo/ledger.json").entries;

const denyIdx = entries.findIndex((e) => (e.event.payload as any).effect === "DENY");
const flipped = structuredClone(entries);
(flipped[denyIdx]!.event.payload as any).effect = "ALLOW";

/** An attacker who recomputes every hash after the edit: the chain is internally valid again. */
function rehash(log: AuditEntry[]): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const e of log) out.push(createAuditEntry(e.event, out.at(-1)?.hash));
  return out;
}

const cases: [string, AuditEntry[]][] = [
  ["untouched ledger", entries],
  ["DENY changed to ALLOW", flipped],
  ["flipped and fully re-hashed", rehash(flipped)],
  ["denial entry (and tail) removed", entries.slice(0, denyIdx)],
];

console.log(`anchor: ${anchor.entryCount} entries, head ${anchor.headHash.slice(0, 18)}..., tx ${anchor.txHash}`);
for (const [label, log] of cases) {
  const v = verifyAgainstAnchor(log, anchor);
  console.log(`${v.ok ? "OK  " : "FAIL"} ${label.padEnd(32)} ${v.ok ? "" : `${v.reason}: ${v.detail}`}`);
}
