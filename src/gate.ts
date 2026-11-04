import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AuditChain, createApprovalRequest, generateId, resolveApproval, sha256, verifyAuditChain,
  type ApprovalRequest, type AuditEntry,
} from "@stlw/warden";
import { buildPolicy, wardenFor, type PolicyFile, type Resource } from "./policy.ts";
import { verifyAgainstAnchor } from "./verify.ts";

export type Verdict = { effect: "ALLOW" | "DENY" | "PENDING_APPROVAL"; matchedRules: string[]; approvalId?: string; reason: string };
type Params = Record<string, unknown>;
type Approval = ApprovalRequest<string, Params & { digest: string }> & { used?: boolean };

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const digestOf = (tool: string, params: Params) => sha256(JSON.stringify([tool, params]));

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Every tool call goes through decide(): Warden evaluates it (deny wins), and the decision is appended to a
 * hash-chained ledger on disk BEFORE anything executes. The ledger is what gets anchored on NEAR.
 */
export class Gate {
  private chain = new AuditChain();
  private policy;
  private warden;

  constructor(
    policyFile: PolicyFile,
    readonly ledgerPath: string,
    private agent = "agent",
    private now: () => number = Date.now,
  ) {
    this.policy = buildPolicy(policyFile);
    this.warden = wardenFor(() => this.chain.entries, this.now);
    this.reload();
    // Fail closed if the file was cut short: a tail-truncated ledger is a valid chain but would reset the daily spend.
    const anchorPath = ledgerPath.replace(/\.json$/, "") + ".anchor.json";
    if (existsSync(anchorPath) && this.chain.entries.length > 0) {
      const v = verifyAgainstAnchor(this.chain.entries, JSON.parse(readFileSync(anchorPath, "utf8")));
      if (!v.ok) throw new Error(`ledger does not match its anchor ${anchorPath} (${v.reason}: ${v.detail}); refusing to append`);
    }
  }

  /** Re-read the ledger file so entries another process appended (e.g. `pnpm approve`) are kept. */
  private reload() {
    if (!existsSync(this.ledgerPath)) return;
    const { entries } = JSON.parse(readFileSync(this.ledgerPath, "utf8")) as { entries: AuditEntry[] };
    const v = verifyAuditChain(entries);
    if (!v.valid) throw new Error(`existing ledger is broken (${v.reason} at ${v.brokenAt}); refusing to append`);
    if (entries.length < this.chain.entries.length) throw new Error("ledger on disk is shorter than the one in memory; refusing to append");
    this.chain.entries.splice(0, this.chain.entries.length, ...entries);
  }

  // In-process: one decide+execute at a time, so spend is reserved (ALLOW is in the ledger) before the next call is evaluated.
  private queue: Promise<unknown> = Promise.resolve();
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.queue.then(fn, fn);
    this.queue = r.catch(() => {});
    return r;
  }

  // Cross-process: a lock directory next to the ledger (mkdir is atomic). Reentrant within this process.
  // ponytail: busy-wait lock with a 10s stale break; fine for one MCP server plus a human CLI, not for many writers.
  private lockDepth = 0;
  private locked<T>(fn: () => T): T {
    if (this.lockDepth++ > 0) { try { return fn(); } finally { this.lockDepth--; } }
    const dir = this.ledgerPath + ".lock";
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    for (let i = 0; ; i++) {
      try { mkdirSync(dir); break; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") { this.lockDepth--; throw e; }
        try { if (Date.now() - statSync(dir).mtimeMs > 10_000) rmSync(dir, { recursive: true, force: true }); } catch {}
        if (i > 2000) { this.lockDepth--; throw new Error(`could not lock ${dir}`); }
        sleep(5);
      }
    }
    try { return fn(); } finally { this.lockDepth--; rmSync(dir, { recursive: true, force: true }); }
  }

  get entries(): readonly AuditEntry[] { return this.chain.entries; }

  private record(eventType: string, payload: unknown, resourceId?: string) {
    this.locked(() => {
      this.reload();
      this.chain.append({ eventId: generateId("evt"), eventType, occurredAt: new Date(this.now()).toISOString(), actor: this.agent, ...(resourceId ? { resourceId } : {}), payload });
      const tmp = this.ledgerPath + ".tmp";
      writeFileSync(tmp, JSON.stringify({ entries: this.chain.entries }, null, 2) + "\n");
      renameSync(tmp, this.ledgerPath);
    });
  }

  private approvalsPath = () => this.ledgerPath.replace(/\.json$/, "") + ".approvals.json";
  private readApprovals = (): Record<string, Approval> => (existsSync(this.approvalsPath()) ? JSON.parse(readFileSync(this.approvalsPath(), "utf8")) : {});
  private writeApprovals = (a: Record<string, Approval>) => writeFileSync(this.approvalsPath(), JSON.stringify(a, null, 2) + "\n");

  /** A call rejected before policy evaluation (malformed amount) still leaves a DENY entry. */
  recordInvalid(tool: string, params: Params, message: string) {
    this.record("near.decision", { tool, params, amountYocto: "0", effect: "DENY", matchedRules: ["invalid_amount"], reason: `invalid_amount: ${message}` });
  }

  async decide(tool: string, params: Params, resource: Resource, approvalId?: string): Promise<Verdict> {
    this.locked(() => this.reload());
    const d = await this.warden.evaluate(this.policy, { subject: { agent: this.agent }, action: tool, resource });
    let { effect } = d;
    let matched = d.matchedRules;
    let approval: string | undefined;
    let reason = d.reasons.map((r) => r.ruleId ?? r.message ?? r.code).join(", ");

    if (effect === "PENDING_APPROVAL" && approvalId) {
      const a = this.readApprovals()[approvalId];
      if (a && a.status === "APPROVED" && !a.used && a.resource.digest === digestOf(tool, params) && Date.parse(a.expiresAt) >= this.now()) {
        effect = "ALLOW";
        matched = [...matched, `approval:${approvalId}`];
        approval = approvalId;
        this.locked(() => { const all = this.readApprovals(); all[approvalId] = { ...a, used: true }; this.writeApprovals(all); });
      } else {
        reason = `approval ${approvalId} is not valid for this exact call (not approved, used, expired or different arguments)`;
        effect = "DENY";
        matched = [...matched, "approval-invalid"];
      }
    } else if (effect === "PENDING_APPROVAL") {
      approval = generateId("appr");
      const requestedAt = new Date(this.now()).toISOString();
      const req = createApprovalRequest({
        requestId: approval, requesterId: this.agent, action: tool, resource: { ...params, digest: digestOf(tool, params) },
        requestedAt, expiresAt: new Date(this.now() + APPROVAL_TTL_MS).toISOString(),
      });
      this.locked(() => { const all = this.readApprovals(); all[req.requestId] = req; this.writeApprovals(all); });
    }

    this.record("near.decision", { tool, params, amountYocto: resource.amountYocto, effect, matchedRules: matched, reason, ...(approval ? { approvalId: approval } : {}) });
    return { effect, matchedRules: matched, reason, ...(approval ? { approvalId: approval } : {}) };
  }

  /** Execution outcome (tx hash) is a ledger entry too, so the anchored head also commits to what actually happened. */
  recordExecution(tool: string, result: unknown) { this.record("near.execution", { tool, ...(result as object) }); }

  /** Human-side: approve or reject a pending request. Run from the CLI; the agent cannot call this. */
  resolve(approvalId: string, decision: "APPROVED" | "REJECTED", approverId: string) {
    this.locked(() => {
    const all = this.readApprovals();
    const a = all[approvalId];
    if (!a) throw new Error(`no such approval: ${approvalId}`);
    all[approvalId] = { ...resolveApproval(a, { decision, approverId, resolvedAt: new Date(this.now()).toISOString() }) };
    this.writeApprovals(all);
    });
    this.record("near.approval", { approvalId, decision, approverId }, approvalId);
  }
}
