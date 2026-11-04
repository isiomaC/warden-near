import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AuditChain, createApprovalRequest, generateId, resolveApproval, sha256, verifyAuditChain,
  type ApprovalRequest, type AuditEntry,
} from "@stlw/warden";
import { buildPolicy, wardenFor, type PolicyFile, type Resource } from "./policy.ts";

export type Verdict = { effect: "ALLOW" | "DENY" | "PENDING_APPROVAL"; matchedRules: string[]; approvalId?: string; reason: string };
type Params = Record<string, unknown>;
type Approval = ApprovalRequest<string, Params & { digest: string }> & { used?: boolean };

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const digestOf = (tool: string, params: Params) => sha256(JSON.stringify([tool, params]));

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
    if (existsSync(ledgerPath)) {
      const { entries } = JSON.parse(readFileSync(ledgerPath, "utf8")) as { entries: AuditEntry[] };
      const v = verifyAuditChain(entries);
      if (!v.valid) throw new Error(`existing ledger is broken (${v.reason} at ${v.brokenAt}); refusing to append`);
      this.chain.entries.push(...entries);
    }
  }

  get entries(): readonly AuditEntry[] { return this.chain.entries; }

  private record(eventType: string, payload: unknown, resourceId?: string) {
    this.chain.append({ eventId: generateId("evt"), eventType, occurredAt: new Date(this.now()).toISOString(), actor: this.agent, ...(resourceId ? { resourceId } : {}), payload });
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    writeFileSync(this.ledgerPath, JSON.stringify({ entries: this.chain.entries }, null, 2) + "\n");
  }

  private approvalsPath = () => this.ledgerPath.replace(/\.json$/, "") + ".approvals.json";
  private readApprovals = (): Record<string, Approval> => (existsSync(this.approvalsPath()) ? JSON.parse(readFileSync(this.approvalsPath(), "utf8")) : {});
  private writeApprovals = (a: Record<string, Approval>) => writeFileSync(this.approvalsPath(), JSON.stringify(a, null, 2) + "\n");

  async decide(tool: string, params: Params, resource: Resource, approvalId?: string): Promise<Verdict> {
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
        const all = this.readApprovals();
        all[approvalId] = { ...a, used: true };
        this.writeApprovals(all);
      } else {
        reason = `approval ${approvalId} is not valid for this exact call (not approved, used, expired or different arguments)`;
        effect = "DENY";
        matched = [...matched, "approval-invalid"];
      }
    } else if (effect === "PENDING_APPROVAL") {
      approval = generateId("appr");
      const requestedAt = new Date(this.now()).toISOString();
      const all = this.readApprovals();
      all[approval] = createApprovalRequest({
        requestId: approval, requesterId: this.agent, action: tool, resource: { ...params, digest: digestOf(tool, params) },
        requestedAt, expiresAt: new Date(this.now() + APPROVAL_TTL_MS).toISOString(),
      });
      this.writeApprovals(all);
    }

    this.record("near.decision", { tool, params, amountYocto: resource.amountYocto, effect, matchedRules: matched, reason, ...(approval ? { approvalId: approval } : {}) });
    return { effect, matchedRules: matched, reason, ...(approval ? { approvalId: approval } : {}) };
  }

  /** Execution outcome (tx hash) is a ledger entry too, so the anchored head also commits to what actually happened. */
  recordExecution(tool: string, result: unknown) { this.record("near.execution", { tool, ...(result as object) }); }

  /** Human-side: approve or reject a pending request. Run from the CLI; the agent cannot call this. */
  resolve(approvalId: string, decision: "APPROVED" | "REJECTED", approverId: string) {
    const all = this.readApprovals();
    const a = all[approvalId];
    if (!a) throw new Error(`no such approval: ${approvalId}`);
    all[approvalId] = { ...resolveApproval(a, { decision, approverId, resolvedAt: new Date(this.now()).toISOString() }) };
    this.writeApprovals(all);
    this.record("near.approval", { approvalId, decision, approverId }, approvalId);
  }
}
