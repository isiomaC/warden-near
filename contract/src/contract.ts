import { NearBindgen, near, call, view, LookupMap, assert } from "near-sdk-js";

type Anchor = { entryCount: number; headHash: string; blockHeight: string; timestampNs: string };

/**
 * Stores, per (publisher account, log id), the latest anchored Warden ledger head.
 * The entry count may only increase, so a truncated log cannot replace a newer anchor.
 * The publisher is the transaction signer's account (predecessor), so nobody can write under another account.
 */
@NearBindgen({})
export class WardenAnchor {
  anchors: LookupMap<Anchor> = new LookupMap<Anchor>("a");

  @call({})
  anchor({ logId, entryCount, headHash }: { logId: string; entryCount: number; headHash: string }): Anchor {
    assert(/^[0-9a-f]{64}$/.test(logId), "logId must be 64 lowercase hex chars");
    assert(/^[0-9a-f]{64}$/.test(headHash), "headHash must be 64 lowercase hex chars");
    assert(Number.isSafeInteger(entryCount) && entryCount > 0, "EmptyLog: entryCount must be a positive integer");
    const key = `${near.predecessorAccountId()}|${logId}`;
    const current = this.anchors.get(key);
    assert(!current || entryCount > current.entryCount, `NotAnAdvance: current ${current?.entryCount}, attempted ${entryCount}`);
    const next: Anchor = {
      entryCount,
      headHash,
      blockHeight: near.blockHeight().toString(),
      timestampNs: near.blockTimestamp().toString(),
    };
    this.anchors.set(key, next);
    near.log(`EVENT_JSON:${JSON.stringify({ standard: "warden-anchor", version: "1.0.0", event: "anchor", data: { publisher: near.predecessorAccountId(), logId, entryCount, headHash } })}`);
    return next;
  }

  @view({})
  latest({ publisher, logId }: { publisher: string; logId: string }): Anchor | null {
    return this.anchors.get(`${publisher}|${logId}`);
  }
}
