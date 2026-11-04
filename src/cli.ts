import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { sha256, type AuditEntry } from "@stlw/warden";
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import { Gate } from "./gate.ts";
import { loadPolicyFile } from "./policy.ts";
import { commit, verifyAgainstAnchor, type Anchor } from "./verify.ts";

const readLog = (path: string): AuditEntry[] => {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(raw) ? raw : raw.entries;
};

type AnchorView = { entryCount: number; headHash: string; blockHeight: string; timestampNs: string } | null;

async function anchor(logPath: string, name = basename(logPath).replace(/\.json$/, "")) {
  const { NEAR_ACCOUNT_ID: accountId, NEAR_PRIVATE_KEY: key, NEAR_CONTRACT_ID: contractId } = process.env;
  if (!accountId || !key || !contractId) throw new Error("Set NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY and NEAR_CONTRACT_ID (see .env, `pnpm setup:testnet`).");
  const { entryCount, headHash } = commit(readLog(logPath)); // throws on a broken or empty log
  const logId = sha256(name);
  const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com" });
  const account = new Account(accountId, provider, KeyPairSigner.fromSecretKey(key as `ed25519:${string}`));

  const tx = await account.callFunctionRaw({ contractId, methodName: "anchor", args: { logId, entryCount, headHash }, gas: 100_000_000_000_000n });
  const onChain = (await provider.callFunction({ contractId, method: "latest", args: { publisher: accountId, logId } })) as AnchorView;
  if (!onChain || onChain.entryCount !== entryCount || onChain.headHash !== headHash) {
    throw new Error(`onchain anchor does not match local commitment: ${JSON.stringify(onChain)}`);
  }
  const record = { network: "near-testnet", contract: contractId, publisher: accountId, logName: name, logId, entryCount, headHash, txHash: tx.transaction.hash, blockHeight: Number(onChain.blockHeight) };
  const out = logPath.replace(/\.json$/, "") + ".anchor.json";
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log(record, `\nwrote ${out}\nexplorer: https://explorer.testnet.near.org/transactions/${record.txHash}`);
}

function verify(logPath: string, anchorPath: string) {
  const a = JSON.parse(readFileSync(anchorPath, "utf8")) as Anchor;
  const v = verifyAgainstAnchor(readLog(logPath), a);
  console.log(v.ok ? `OK: ${v.entries} entries, anchored head at ${v.anchoredCount} matches` : `FAIL ${v.reason}: ${v.detail}`);
  process.exitCode = v.ok ? 0 : 1;
}

/** Human approval of a pending large spend. The agent has no tool for this. */
function approve(id: string, decision: "APPROVED" | "REJECTED") {
  const gate = new Gate(loadPolicyFile(process.env.WARDEN_NEAR_POLICY ?? "policy/near-policy.json"), process.env.WARDEN_NEAR_LEDGER ?? ".warden/ledger.json");
  gate.resolve(id, decision, process.env.USER ?? "human");
  console.log(`${decision} ${id}`);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "anchor" && a) await anchor(a, b);
else if (cmd === "verify" && a && b) verify(a, b);
else if (cmd === "approve" && a) approve(a, b === "reject" ? "REJECTED" : "APPROVED");
else {
  console.error("usage:\n  anchor <log.json> [log-name]     anchor a log's head on NEAR testnet\n  verify <log.json> <anchor.json>  check a log offline against an anchor record\n  approve <approval-id> [reject]   human approval of a pending large spend");
  process.exitCode = 2;
}
