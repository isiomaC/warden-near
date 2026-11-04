# warden-near

A policy-gated wallet for AI agents on NEAR. The agent talks to an MCP server; every balance read, transfer and contract call is checked by [Warden](https://github.com/isiomaC/warden)'s deny-wins policy engine first; every decision is written to a hash-chained ledger; the ledger head (entry count plus head hash) is anchored in a contract on NEAR testnet; an offline verifier detects edited, rewritten and truncated ledgers.

Built for the NEAR Hackathon (submissions close 14 Nov 2026 23:59 UTC).
Track fit is discussed in [docs/submission-idea.md](docs/submission-idea.md); the final choice is the owner's.

**Status: working prototype on NEAR testnet.** Testnet only. Not audited. Holds no real funds. Details under [Honest status](#honest-status).

## For a machine reader (start here)

- **What it is.** An MCP server (`src/mcp-server.ts`) exposing four tools: `near_get_balance`, `near_view`, `near_transfer`, `near_call_contract`. A policy file (`policy/near-policy.json`) is compiled to Warden rules. A contract (`contract/src/contract.ts`) stores ledger heads. A CLI (`src/cli.ts`) anchors and verifies.
- **Problem.** An agent with a wallet can be talked into paying the wrong party or calling the wrong contract (prompt injection, bad tool output). For a direct transfer from an account, function-call access keys cannot attach NEAR ([docs.near.org/protocol/access-keys](https://docs.near.org/protocol/access-keys)), so an agent that pays directly needs a full-access key somewhere. The key has to sit behind something that says no. (The alternative, a function-call key that can only call a vault contract method that does the transfer, is a design this repo did not build; it moves the policy into contract code and loses the off-chain approval flow and the ledger.) And the record that it said no is usually a log on the same machine, which whoever controls the machine can edit, re-hash or cut short.
- **Solution.** The key lives only in the MCP server process, never in the agent. Warden decides first, fail-closed: deny wins over approval, approval wins over allow, no matching rule is a deny. The decision is appended to the ledger before anything executes. The head is anchored onchain, so an edit, a full re-hash rewrite or a truncation fails verification.
- **Run it offline in one minute**: [Quick start](#quick-start). Steps 1 to 5 need no network and no key.

## Quick start

Requires Node 22+ and pnpm 10.

1. `pnpm install --frozen-lockfile` (pnpm may print an "Ignored build scripts" notice; it is informational, `pnpm build:contract` handles that step).
2. `pnpm typecheck`, then `pnpm build:contract && pnpm test` : expect all tests to pass. Without `pnpm build:contract` the 4 contract sandbox tests skip; on Intel macOS they always skip (near-sandbox has no binary there).
3. `pnpm demo` : a scripted agent calls the real MCP server on a mock chain; the approval is resolved through a second `Gate` on the same ledger file, the same path as `pnpm approve` in another process. Expect six `ok` and five `BLOCKED` lines: unknown recipient, non-allowlisted contract, over the per-call cap and over the daily cap are denied, and a 0.8 NEAR transfer is held for approval, then passes after `approve`. Writes `.warden/demo-ledger.json`.
4. `pnpm verify demo/ledger.json demo/ledger.anchor.json` : checks the recorded testnet ledger against its recorded anchor. Expect `OK: 18 entries, anchored head at 18 matches`.
5. `pnpm demo:tamper` : replays three attacks on that ledger. Expect `OK` for the untouched ledger, then `FAIL CHAIN_BROKEN` (decision flipped), `FAIL REWRITTEN` (flipped and every hash recomputed) and `FAIL TRUNCATED` (denial and tail removed).
6. Confirm the anchor onchain without trusting this repo: `curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"warden-anchor-lkazab.testnet","method_name":"latest","args_base64":"eyJwdWJsaXNoZXIiOiJ3YXJkZW4tYWdlbnQtbGthemFiLnRlc3RuZXQiLCJsb2dJZCI6IjRjM2MzZTNmMTExMDkyZmJiN2YxMWViOWM0ZWNlNjUzNWQ2YjEyMDBmNWNmN2U2MDE4ZDhhOWUxYTA1MmE3ZDIifQ=="}}' | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log(Buffer.from(r.result.result).toString())'` prints `{"entryCount":18,"headHash":"726a9a76...a80",...}`, equal to `demo/ledger.anchor.json` (run once by the author on 2026-11-04). This curl is the primary proof; it does not use any explorer.

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

`demo/ledger.json` is the exact ledger of the real testnet run. The `explorer.testnet.near.org` links above are the URLs near-cli-rs prints. They return HTTP 200 but land on a "NEAR Explorer Selector" page, not directly on the transaction. A direct testnet explorer URL for the anchor tx is `https://testnet.nearblocks.io/txns/4uEgtC8UyXnVQf8jh5wXre3gq257yPwi82nDhtSFTNwx` (it answers curl with HTTP 403 because of bot protection, so I could not check it from a script; open it in a browser). The RPC read-back in `anchor` and the curl in Quick start step 6 are the proof.

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

Warden's YAML policy and `warden proxy` match on tool names and regexes over the input. They have no numeric comparison and no cumulative spend (a regex over the JSON could approximate a fixed threshold; a daily cap cannot be expressed). This repo therefore uses Warden's embedding API instead (`createWarden`, `definePolicy`, custom conditions and a ledger-backed resolver, `PENDING_APPROVAL`, `AuditChain`), and the MCP server itself is the enforcement point. It is the same deny-wins engine and ledger format, not the proxy binary. `@stlw/warden-cli` is not used, so it is not a dependency.

## Prior work and what is new

Rules, from [nearhackathon.com/HACKATHON.md](https://nearhackathon.com/HACKATHON.md) (fetched 2026-11-04):

- Q-001: "Code before 2026-11-01? Yes, from the announcement on 2026-10-19 ... The window runs from then to 2026-11-14. Earlier commits are baseline."
- Q-002: "Existing product on another chain? Allowed. Only the NEAR integration built in the window is judged. Disclose in README."
- Q-004: "Old project or new feature on it? Old project as-is: no. New feature in the window: yes, if separated per Q-003."
- Q-005: "Libraries, templates, boilerplate? All allowed, including own pre-hackathon libs and AI code. List in README; own old libs count as baseline."

The window starts at the announcement on 2026-10-19. This repository was created on 2026-11-04, inside the window, and all of its commits are in the window. Two earlier projects of the same author are **baseline** (not counted as new work) and are listed here:

| Prior work | Created | Licence | How it is used here |
| --- | --- | --- | --- |
| [Warden](https://github.com/isiomaC/warden) (`@stlw/warden` 0.2.9) | 2026-05-10 | MIT | Baseline library, pinned npm dependency, not copied: policy engine, `AuditChain`, approvals. |
| [warden-anchor](https://github.com/isiomaC/warden-anchor) | 2026-10-10 | MIT | Baseline, built for the Monad hackathon before the window. The anchor idea and the **verifier (`src/verify.ts`), the CLI shape (`src/cli.ts`) and the tamper demo (`src/tamper-demo.ts`) are ported from it** (Solidity to a NEAR contract, viem to near-api-js, SQLite ledger entries replaced by `AuditChain` entries). The browser verifier was not ported. |

New in the window, written for NEAR: the wallet MCP server and its four tools (`src/mcp-server.ts`, `src/tools.ts`), the NEAR policy (caps, allowlists, approval flow, ledger-derived daily cap: `src/policy.ts`, `src/gate.ts`, `policy/`), the `WardenAnchor` NEAR contract (`contract/`), the NEAR-specific parts of the CLI (anchoring through near-api-js), the testnet setup and deploy scripts, the demo, the recorded testnet run and the tests. Other libraries are listed in `package.json` (near-api-js, near-sdk-js, near-workspaces, near-cli-rs, MCP SDK, zod, vitest, tsx).

## Honest status

- Works, and was run: unit tests of the policy, approvals, verifier, concurrency and integrity (17 tests, plus 4 contract sandbox tests); the full demo on a mock chain; the full demo on NEAR testnet including real transfers, an onchain anchor, read-back and offline verification; the three tamper cases.
- The contract sandbox tests (`test/contract.test.ts`, near-workspaces) are skipped on the author's Intel Mac (near-sandbox has no binary for it), so they were not run locally. They run in GitHub Actions on Linux, where all four pass (CI run 41810020187). The contract was also exercised on testnet.
- Contract language: TypeScript with near-sdk-js 2.0.0, as intended. It builds and runs, but it was last released in June 2024 and NEAR's own docs call near-sdk-rs the only official SDK. A Rust port would be the production choice.
- The anchor contract trusts the signing account for its own logs (anyone can anchor under their own account). A verifier must check which publisher the anchor record names.
- An anchor proves a ledger head existed at that block. It cannot prove entries a compromised host never wrote, or events before the first anchor.
- Warden governs calls that go through this MCP server. An agent with other tools (shell, its own keys) is outside this boundary.
- The agent's wallet key is full-access, because a direct transfer needs one (function-call keys cannot attach NEAR). A contract-vault design with a function-call key was not built. Blast radius is limited by funding the agent account with a small balance, not by the key type.
- Daily spend is counted when a call is allowed, not when the transaction lands; a failed transaction is recorded as a `near.execution` error entry and still uses cap (the reservation is not released).
- Concurrency bug found and fixed: an independent check sent 8 parallel 0.5 NEAR transfers against the 2 NEAR daily cap and all 8 were allowed, because the cap was computed from the ledger before the new decision was written and nothing made calls take turns. Now each call's decide, execute and ledger write run one at a time per server (`Gate.exclusive`), so the same test allows exactly 4 and denies 4 (`test/policy.test.ts`). The check is per process: two separate MCP servers sharing one ledger file serialize their file writes (lock directory) but each evaluates the cap on its own snapshot, so run one server per ledger.
- Approval loss found and fixed: `pnpm approve` runs in a second process and appends an approval entry; the running server used to rewrite the whole file from memory and drop it. The Gate now reloads and re-verifies the file under a lock before each decision and append.
- Malformed amounts are recorded as a DENY entry (`invalid_amount`).
- At startup the Gate compares the ledger with `<ledger>.anchor.json` when that file exists and refuses to run on a mismatch (a tail-truncated file would otherwise reset the daily spend). With no anchor file present, a truncated ledger is undetectable; anchor early.
- Latest green CI run: run 41810020187 (all 21 tests passed on Linux, including the 4 contract sandbox tests; it is the run for the code commit's docs push 1c7409e).
- Testnet only. Mainnet is refused in code and was never touched.
- Full list of what was and was not checked against NEAR's docs: [docs/verified-facts.md](docs/verified-facts.md).

## Layout

`src/mcp-server.ts` MCP server, `src/tools.ts` the four tools, `src/gate.ts` policy plus ledger plus approvals, `src/policy.ts` Warden policy, `src/verify.ts` verifier, `src/cli.ts` anchor/verify/approve, `src/demo.ts`, `contract/src/contract.ts`, `policy/`, `demo/` (recorded run), `scripts/`, `test/`.

## AI tooling disclosure

Built with AI coding assistance.

## Licence

MIT. See [LICENSE](LICENSE).
