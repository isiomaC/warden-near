# warden-near

A policy-gated wallet for AI agents on NEAR. The agent talks to an MCP server; every balance read, transfer and contract call is checked by [Warden](https://github.com/isiomaC/warden)'s deny-wins policy engine first; every decision is written to a hash-chained ledger; the ledger head (entry count plus head hash) is anchored in a contract on NEAR testnet; an offline verifier detects edited, rewritten and truncated ledgers.

Built for the NEAR Hackathon (submissions close 14 Nov 2026 23:59 UTC).
Tracks: AI Security & Defense (primary), Agent Economy, Autonomous Business. Open Innovation only because the onchain anchor ships and works.

**Status: working prototype on NEAR testnet.** Testnet only. Not audited. Holds no real funds. Details under [Honest status](#honest-status).

## For a machine reader (start here)

- **What it is.** An MCP server (`src/mcp-server.ts`) exposing four tools: `near_get_balance`, `near_view`, `near_transfer`, `near_call_contract`. A policy file (`policy/near-policy.json`) is compiled to Warden rules. A contract (`contract/src/contract.ts`) stores ledger heads. A CLI (`src/cli.ts`) anchors and verifies.
- **Problem.** An agent with a wallet can be talked into paying the wrong party or calling the wrong contract (prompt injection, bad tool output). Function-call access keys cannot attach NEAR, so any agent that must pay needs a full-access key somewhere. The key has to sit behind something that says no. And the record that it said no is usually a log on the same machine, which whoever controls the machine can edit, re-hash or cut short.
- **Solution.** The key lives only in the MCP server process, never in the agent. Warden decides first, fail-closed: deny wins over approval, approval wins over allow, no matching rule is a deny. The decision is appended to the ledger before anything executes. The head is anchored onchain, so an edit, a full re-hash rewrite or a truncation fails verification.
- **Run it offline in one minute**: [Quick start](#quick-start). Steps 1 to 5 need no network and no key.

## Quick start

Requires Node 22+ and pnpm 10.

1. `pnpm install`
2. `pnpm typecheck` and `pnpm test` : expect all non-skipped tests to pass (contract sandbox tests are skipped on Intel macOS, see status).
3. `pnpm demo` : a scripted agent calls the real MCP server on a mock chain. Expect six `ok` and five `BLOCKED` lines: unknown recipient, non-allowlisted contract, over the per-call cap and over the daily cap are denied, and a 0.8 NEAR transfer is held for approval, then passes after `approve`. Writes `.warden/demo-ledger.json`.
4. `pnpm verify demo/ledger.json demo/ledger.anchor.json` : checks the recorded testnet ledger against its recorded anchor. Expect `OK: 18 entries, anchored head at 18 matches`.
5. `pnpm demo:tamper` : replays three attacks on that ledger. Expect `OK` for the untouched ledger, then `FAIL CHAIN_BROKEN` (decision flipped), `FAIL REWRITTEN` (flipped and every hash recomputed) and `FAIL TRUNCATED` (denial and tail removed).
6. Confirm the anchor onchain without trusting this repo: `curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"warden-anchor-lkazab.testnet","method_name":"latest","args_base64":"eyJwdWJsaXNoZXIiOiJ3YXJkZW4tYWdlbnQtbGthemFiLnRlc3RuZXQiLCJsb2dJZCI6IjRjM2MzZTNmMTExMDkyZmJiN2YxMWViOWM0ZWNlNjUzNWQ2YjEyMDBmNWNmN2U2MDE4ZDhhOWUxYTA1MmE3ZDIifQ=="}}' | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log(Buffer.from(r.result.result).toString())'` prints `{"entryCount":18,"headHash":"726a9a76...a80",...}`, equal to `demo/ledger.anchor.json` (run once by the author on 2026-11-04).

### Run it on your own testnet accounts

7. `pnpm setup:testnet` : creates two throwaway testnet accounts through the NEAR faucet service (no funds or secrets needed from you) and writes their keys to `.env` (git-ignored, mode 600). Only account ids are printed.
8. `pnpm build:contract && pnpm deploy:contract` : builds the contract with near-sdk-js and deploys it to your contract account.
9. `pnpm demo -- --testnet` : the same scenario with real testnet transfers, then anchors the ledger to `demo/ledger.json` + `demo/ledger.anchor.json` and verifies it. (The default policy pays the vendor named in `policy/near-policy.json`; edit it to your own accounts first if you do not want to pay the author's testnet account.)
10. To plug the server into an MCP client: `command: pnpm`, `args: ["mcp"]` (stdio). Set `WARDEN_NEAR_MOCK=1` for the mock chain.

## What is recorded

| Item | Value |
| --- | --- |
| Network | NEAR testnet |
| Contract account | `warden-anchor-lkazab.testnet` |
| Deploy tx | [`GJosJ3trTa4AoJayjxrM6XCEuv8fhVDA4pC9Je6us4Ag`](https://explorer.testnet.near.org/transactions/GJosJ3trTa4AoJayjxrM6XCEuv8fhVDA4pC9Je6us4Ag) |
| Agent wallet / publisher | `warden-agent-lkazab.testnet` |
| Anchor tx (18-entry demo ledger) | [`4uEgtC8UyXnVQf8jh5wXre3gq257yPwi82nDhtSFTNwx`](https://explorer.testnet.near.org/transactions/4uEgtC8UyXnVQf8jh5wXre3gq257yPwi82nDhtSFTNwx) |
| Head hash | `726a9a76ecc5ea56899250d4f5292b967d26bf9aaec2c141c3058e991cca0a80` |
| Transfers in the demo | txs listed in `demo/ledger.json` (`near.execution` entries) |

`demo/ledger.json` is the exact ledger of the real testnet run. The explorer URL is the one near-cli-rs prints; I did not open it in a browser, the RPC read-back in `anchor` is what was checked.

## Architecture

```
agent (any MCP client)
   │  near_transfer / near_call_contract / near_view / near_get_balance
   ▼
warden-near MCP server  ── holds the NEAR key; the agent never sees it
   │  1. Warden.evaluate(policy, call)      deny > pending approval > allow, no match = deny
   │  2. append decision to ledger          (hash-chained, on disk, BEFORE execution)
   │  3. ALLOW only: near-api-js sends the tx, outcome (tx hash) appended to the ledger
   ▼
NEAR testnet                         pnpm anchor: verify chain, call anchor(logId, count, head)
                                              ▼
                              WardenAnchor contract (per publisher account + log id, count only increases)
                                              ▼
                      pnpm verify <log> <anchor>: offline, no network: OK / CHAIN_BROKEN / REWRITTEN / TRUNCATED
```

### Policy (`policy/near-policy.json`)

| Setting | Default | Rule |
| --- | --- | --- |
| `perCallNear` | 1 | `deny-over-per-call-cap` |
| `dailyNear` | 2 | `deny-over-daily-cap`, computed from the ledger's own last-24h ALLOW entries |
| `approvalAboveNear` | 0.5 | `approve-large-spend` (PENDING_APPROVAL) |
| `allowedContracts` | anchor contract, a guestbook example | `deny-contract-not-allowlisted` |
| `allowedRecipients` | the vendor account | `deny-recipient-not-allowlisted` |

Approval path: a large spend returns `PENDING_APPROVAL <id>`. A human runs `pnpm approve <id>` (the agent has no tool for this). The agent retries the identical call with `approval_id`. The approval is bound to the exact tool and arguments (SHA-256 digest), single use, expires after 10 minutes, and cannot override a deny. Approval requests use Warden's `createApprovalRequest`/`resolveApproval`.

### How Warden is used, and one deviation

The task framing was "behind the Warden MCP gateway". Warden's YAML policy and `warden proxy` match on tool names and regexes over the input; they have no numeric comparison, so they cannot express "at most 1 NEAR per call and 2 per day". This repo therefore uses Warden's embedding API instead (`createWarden`, `definePolicy`, custom conditions and a ledger-backed resolver, `PENDING_APPROVAL`, `AuditChain`), and the MCP server itself is the enforcement point. It is the same deny-wins engine and ledger format, not the proxy binary. `@stlw/warden-cli` is not used, so it is not a dependency.

## Prior work and what is new

This repository was created on 4 Nov 2026. The hackathon page says "Code written since the announcement counts" and does not say more about earlier code, so prior work is listed explicitly.

| Prior work | Version | Licence | How it is used here |
| --- | --- | --- | --- |
| [Warden](https://github.com/isiomaC/warden) (`@stlw/warden`) | 0.2.9, pinned npm dependency, not copied | MIT | policy engine, `AuditChain`, approvals |
| [warden-anchor](https://github.com/isiomaC/warden-anchor) | n/a (Monad hackathon, Oct 2026) | MIT | the anchor idea and the verifier logic (`src/verify.ts`, `src/tamper-demo.ts`, `src/cli.ts`) were **copied and ported**: Solidity to a NEAR contract, viem to near-api-js, SQLite ledger entries dropped in favour of `AuditChain` entries |

New in this repository: the NEAR wallet MCP server and tools, the NEAR policy (caps, allowlists, approval, ledger-derived daily cap), the `WardenAnchor` NEAR contract (TypeScript, near-sdk-js), the NEAR anchor CLI, the testnet setup and deploy scripts, the demo, the recorded testnet run and the tests. The warden-anchor browser verifier was **not** ported.

## Honest status

- Works, and was run: unit tests of the policy, approvals and verifier (11 tests); the full demo on a mock chain; the full demo on NEAR testnet including real transfers, an onchain anchor, read-back and offline verification; the three tamper cases.
- The contract sandbox tests (`test/contract.test.ts`, near-workspaces) are written but were **not run**: the author's machine is an Intel Mac and near-sandbox has no binary for it. They are set to run in CI on Linux. The contract itself was exercised on testnet.
- Contract language: TypeScript with near-sdk-js 2.0.0, as intended. It builds and runs, but it was last released in June 2024 and NEAR's own docs call near-sdk-rs the only official SDK. A Rust port would be the production choice.
- The anchor contract trusts the signing account for its own logs (anyone can anchor under their own account). A verifier must check which publisher the anchor record names.
- An anchor proves a ledger head existed at that block. It cannot prove entries a compromised host never wrote, or events before the first anchor.
- Warden governs calls that go through this MCP server. An agent with other tools (shell, its own keys) is outside this boundary.
- The agent's wallet key is full-access, because function-call keys cannot attach NEAR. Blast radius is limited by funding the agent account with a small balance, not by the key type.
- Daily spend is counted when a call is allowed, not when the transaction lands; a failed transaction still uses cap.
- Testnet only. Mainnet is refused in code and was never touched.
- Full list of what was and was not checked against NEAR's docs: [docs/verified-facts.md](docs/verified-facts.md).

## Layout

`src/mcp-server.ts` MCP server, `src/tools.ts` the four tools, `src/gate.ts` policy plus ledger plus approvals, `src/policy.ts` Warden policy, `src/verify.ts` verifier, `src/cli.ts` anchor/verify/approve, `src/demo.ts`, `contract/src/contract.ts`, `policy/`, `demo/` (recorded run), `scripts/`, `test/`.

## AI tooling disclosure

Built with AI coding assistance.

## Licence

MIT. See [LICENSE](LICENSE).
