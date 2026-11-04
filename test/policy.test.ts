import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

describe("concurrency, cross-process, integrity", () => {
  const ledgerOf = () => (gate as any).ledgerPath as string;
  const spent = () => decisions().filter((d) => d.effect === "ALLOW").length;

  test("8 parallel 0.5 NEAR transfers against a 2 NEAR daily cap: exactly 4 allowed", async () => {
    // 0.5 is not above approvalAboveNear (0.5) so no approval path; 4 x 0.5 = 2 = cap
    const rs = await Promise.all(Array.from({ length: 8 }, () => t.near_transfer({ receiver_id: vendor, amount_near: "0.5" })));
    expect(rs.filter((r) => r.ok)).toHaveLength(4);
    expect(rs.filter((r) => r.text.includes("deny-over-daily-cap"))).toHaveLength(4);
    expect(chain.sent).toHaveLength(4);
    expect(spent()).toBe(4);
    expect(verifyAuditChain(gate.entries).valid).toBe(true);
    expect(verifyAuditChain(JSON.parse(readFileSync(ledgerOf(), "utf8")).entries).valid).toBe(true);
  });

  test("concurrent decisions on a slow chain still respect the cap", async () => {
    const orig = chain.transfer;
    chain.transfer = async (...a) => { await new Promise((r) => setTimeout(r, 10)); return orig(...a); };
    const rs = await Promise.all(Array.from({ length: 8 }, () => t.near_transfer({ receiver_id: vendor, amount_near: "0.5" })));
    expect(rs.filter((r) => r.ok)).toHaveLength(4);
  });

  test("a failed execution is recorded and keeps its reservation", async () => {
    chain.transfer = async () => { throw new Error("rpc down"); };
    expect((await t.near_transfer({ receiver_id: vendor, amount_near: "0.5" })).ok).toBe(false);
    expect(gate.entries.some((e) => e.event.eventType === "near.execution" && (e.event.payload as any).error === "rpc down")).toBe(true);
    chain = mockChain(); t = walletTools(gate, chain);
    for (let i = 0; i < 3; i++) expect((await t.near_transfer({ receiver_id: vendor, amount_near: "0.5" })).ok).toBe(true);
    expect((await t.near_transfer({ receiver_id: vendor, amount_near: "0.5" })).ok).toBe(false);
  });

  test("two Gates on one ledger file: an approval written by the other process is not lost", async () => {
    const other = new Gate(policy, ledgerOf(), "test-agent", () => clock); // what `pnpm approve` does
    const p = await t.near_transfer({ receiver_id: vendor, amount_near: "0.8" });
    const id = /PENDING_APPROVAL (\S+):/.exec(p.text)![1]!;
    other.resolve(id, "APPROVED", "human");
    expect((await t.near_transfer({ receiver_id: vendor, amount_near: "0.8", approval_id: id })).ok).toBe(true);
    const disk = JSON.parse(readFileSync(ledgerOf(), "utf8")).entries;
    expect(disk.some((e: any) => e.event.eventType === "near.approval" && e.event.payload.approvalId === id)).toBe(true);
    expect(verifyAuditChain(disk).valid).toBe(true);
    expect(gate.entries.length).toBe(disk.length);
  });

  test("malformed amounts leave a DENY entry with reason invalid_amount", async () => {
    await t.near_transfer({ receiver_id: vendor, amount_near: "1e3" });
    await t.near_call_contract({ contract_id: policy.allowedContracts[0]!, method: "m", deposit_near: "-1" });
    const d = decisions();
    expect(d).toHaveLength(2);
    expect(d.every((x) => x.effect === "DENY" && x.matchedRules[0] === "invalid_amount")).toBe(true);
    expect(chain.sent).toHaveLength(0);
  });

  test("a tail-truncated ledger that no longer matches its anchor is refused at startup", async () => {
    await t.near_transfer({ receiver_id: vendor, amount_near: "0.5" }); // 2 entries
    const path = ledgerOf();
    const a = commit(gate.entries);
    writeFileSync(path.replace(/\.json$/, ".anchor.json"), JSON.stringify(a));
    const raw = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ entries: raw.entries.slice(0, 1) }));
    expect(() => new Gate(policy, path)).toThrow(/does not match its anchor.*TRUNCATED/);
  });
});
