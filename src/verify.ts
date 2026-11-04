import { verifyAuditChain, type AuditEntry } from "@stlw/warden";

export type Anchor = { entryCount: number; headHash: string };
export type Verdict =
  | { ok: true; entries: number; anchoredCount: number }
  | { ok: false; reason: "CHAIN_BROKEN" | "TRUNCATED" | "REWRITTEN" | "EMPTY"; detail: string };

const bare = (h: string) => h.replace(/^0x/, "").toLowerCase();

/** The commitment published onchain for a log. Throws if the log is not a valid chain. */
export function commit(entries: readonly AuditEntry[]): Anchor {
  const v = verifyAuditChain(entries);
  if (!v.valid) throw new Error(`log is not a valid chain: ${v.reason} at entry ${v.brokenAt}`);
  if (entries.length === 0) throw new Error("log is empty");
  return { entryCount: entries.length, headHash: bare(entries[entries.length - 1]!.hash) };
}

/**
 * Check a log against an anchored commitment. Needs no network: the anchor is data.
 * edit inside the chain -> CHAIN_BROKEN; rewrite and re-hash everything -> REWRITTEN; drop the tail -> TRUNCATED.
 * Entries appended after the anchor are allowed.
 */
export function verifyAgainstAnchor(entries: readonly AuditEntry[], anchor: Anchor): Verdict {
  if (entries.length === 0) return { ok: false, reason: "EMPTY", detail: "log has no entries" };
  const chain = verifyAuditChain(entries);
  if (!chain.valid) return { ok: false, reason: "CHAIN_BROKEN", detail: `${chain.reason} at entry ${chain.brokenAt}` };
  if (entries.length < anchor.entryCount) {
    return { ok: false, reason: "TRUNCATED", detail: `log has ${entries.length} entries, ${anchor.entryCount} were anchored` };
  }
  const atAnchor = entries[anchor.entryCount - 1]!;
  if (bare(atAnchor.hash) !== bare(anchor.headHash)) {
    return { ok: false, reason: "REWRITTEN", detail: `entry ${anchor.entryCount} hash ${atAnchor.hash} does not match anchored head ${bare(anchor.headHash)}` };
  }
  return { ok: true, entries: entries.length, anchoredCount: anchor.entryCount };
}
