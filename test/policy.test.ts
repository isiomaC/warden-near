import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAuditChain } from "@stlw/warden";
import { beforeEach, describe, expect, test } from "vitest";
import { Gate } from "../src/gate.ts";
import { mockChain } from "../src/near.ts";
import { loadPolicyFile } from "../src/policy.ts";
import { walletTools } from "../src/tools.ts";
import { commit, verifyAgainstAnchor } from "../src/verify.ts";

const policy = loadPolicyFile("policy/near-policy.json");
const vendor = policy.allowedRecipients[0]!;
let gate: Gate, chain: ReturnType<typeof mockChain>, t: ReturnType<typeof walletTools>, clock: number;

beforeEach(() => {
  clock = Date.now();
  gate = new Gate(policy, join(mkdtempSync(join(tmpdir(), "wn-")), "ledger.json"), "test-agent", () => clock);
  chain = mockChain();
  t = walletTools(gate, chain);
});

const decisions = () => gate.entries.filter((e) => e.event.eventType === "near.decision").map((e) => e.event.payload as any);

describe("policy", () => {
  test("allowed call passes and executes", async () => {
    const r = await t.near_transfer({ receiver_id: vendor, amount_near: "0.1" });
    expect(r.ok).toBe(true);
    expect(chain.sent).toHaveLength(1);
    expect(decisions().at(-1).effect).toBe("ALLOW");
  });

  test("over the per-call cap is denied and nothing executes", async () => {
    const r = await t.near_transfer({ receiver_id: vendor, amount_near: "5" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("deny-over-per-call-cap");
    expect(chain.sent).toHaveLength(0);
  });

  test("non-allowlisted contract is denied", async () => {
    const r = await t.near_call_contract({ contract_id: "evil.testnet", method: "drain" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("deny-contract-not-allowlisted");
    expect(chain.sent).toHaveLength(0);
  });

  test("non-allowlisted recipient is denied", async () => {
    expect((await t.near_transfer({ receiver_id: "attacker.testnet", amount_near: "0.1" })).ok).toBe(false);
  });

  test("allowlisted contract call passes", async () => {
    expect((await t.near_call_contract({ contract_id: policy.allowedContracts[1]!, method: "add_message", args: { text: "hi" } })).ok).toBe(true);
  });

  test("malformed amounts are rejected before policy", async () => {
    expect((await t.near_transfer({ receiver_id: vendor, amount_near: "-1" })).ok).toBe(false);
    expect((await t.near_transfer({ receiver_id: vendor, amount_near: "1e3" })).ok).toBe(false);
  });

  test("daily cap: the call that would cross it is denied, earlier ones are not", async () => {
    for (let i = 0; i < 4; i++) expect((await t.near_transfer({ receiver_id: vendor, amount_near: "0.5" })).ok).toBe(true);
    const r = await t.near_transfer({ receiver_id: vendor, amount_near: "0.1" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("deny-over-daily-cap");
    clock += 25 * 3600 * 1000; // window rolls over
    expect((await t.near_transfer({ receiver_id: vendor, amount_near: "0.1" })).ok).toBe(true);
  });

  test("large transfer needs approval, which is bound to the exact call and single use", async () => {
    const p = await t.near_transfer({ receiver_id: vendor, amount_near: "0.8" });
    const id = /PENDING_APPROVAL (\S+):/.exec(p.text)![1]!;
    expect(chain.sent).toHaveLength(0);
    expect((await t.near_transfer({ receiver_id: vendor, amount_near: "0.8", approval_id: id })).ok).toBe(false); // not approved yet
    gate.resolve(id, "APPROVED", "human");
    expect((await t.near_transfer({ receiver_id: vendor, amount_near: "0.9", approval_id: id })).ok).toBe(false); // different amount
    expect((await t.near_transfer({ receiver_id: vendor, amount_near: "0.8", approval_id: id })).ok).toBe(true);
    expect((await t.near_transfer({ receiver_id: vendor, amount_near: "0.8", approval_id: id })).ok).toBe(false); // replay
  });

  test("an approval cannot override a deny", async () => {
    const p = await t.near_transfer({ receiver_id: vendor, amount_near: "0.8" });
    const id = /PENDING_APPROVAL (\S+):/.exec(p.text)![1]!;
    gate.resolve(id, "APPROVED", "human");
    const r = await t.near_transfer({ receiver_id: "attacker.testnet", amount_near: "0.8", approval_id: id });
    expect(r.ok).toBe(false);
  });
});

describe("ledger", () => {
  test("a denial lands in the ledger, the chain verifies, and a reloaded Gate continues it", async () => {
    await t.near_call_contract({ contract_id: "evil.testnet", method: "drain" });
    const denial = decisions().at(-1);
    expect(denial).toMatchObject({ tool: "near_call_contract", effect: "DENY", matchedRules: ["deny-contract-not-allowlisted"] });
    expect(verifyAuditChain([...gate.entries]).valid).toBe(true);
    const again = new Gate(policy, gate.ledgerPath, "test-agent", () => clock);
    expect(again.entries).toHaveLength(gate.entries.length);
  });

  test("anchor detects edit, re-hash rewrite and truncation", async () => {
    await t.near_transfer({ receiver_id: vendor, amount_near: "0.1" });
    await t.near_call_contract({ contract_id: "evil.testnet", method: "drain" });
    const entries = structuredClone([...gate.entries]);
    const anchor = commit(entries);
    expect(verifyAgainstAnchor(entries, anchor).ok).toBe(true);

    const flipped = structuredClone(entries);
    (flipped.find((e) => (e.event.payload as any).effect === "DENY")!.event.payload as any).effect = "ALLOW";
    expect(verifyAgainstAnchor(flipped, anchor)).toMatchObject({ ok: false, reason: "CHAIN_BROKEN" });

    const { createAuditEntry } = await import("@stlw/warden");
    const rehashed: typeof entries = [];
    for (const e of flipped) rehashed.push(createAuditEntry(e.event, rehashed.at(-1)?.hash));
    expect(verifyAgainstAnchor(rehashed, anchor)).toMatchObject({ ok: false, reason: "REWRITTEN" });

    expect(verifyAgainstAnchor(entries.slice(0, -1), anchor)).toMatchObject({ ok: false, reason: "TRUNCATED" });
  });
});
