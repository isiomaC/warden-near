# Submission draft

Form fields from https://nearhackathon.com/HACKATHON.md (fetched 2026-11-04). Re-read it before submitting. The owner fills the blanks; nothing here is submitted.

## `idea` (1336 characters, limit 20-2000)

```
AI agents that hold a wallet can be talked into paying the wrong party or calling the wrong contract, and the log that says they were stopped usually sits on the same machine, where it can be edited or cut short. warden-near is a policy-gated wallet for agents on NEAR testnet. An MCP server exposes four tools (balance, view, transfer, contract call). The wallet key lives only in the server, never in the agent. Every call is first checked by the Warden policy engine, deny wins: per-call cap, a daily cap computed from the ledger itself, recipient and contract allowlists, and human approval for large spends, bound to the exact call, single use, expiring. Each decision is appended to a hash-chained ledger before anything executes, and the transaction hash is appended after. A small NEAR contract (TypeScript, near-sdk-js) stores the ledger head (entry count and hash) per publisher, count only increasing. An offline verifier then detects an edited ledger, a fully re-hashed rewrite, or a truncated tail against the onchain anchor. A recorded testnet run with real transfers and an anchor is in the repo and checkable with one RPC curl. Honest limits: testnet only, not audited, full-access key held by the server, the contract trusts each publisher for its own logs. Not built: NEAR Intents, chain signatures, sub-accounts, TEE.
```

## Tracks: what the code honestly supports

Track ids in the form: `security` (AI Security & Defense), `agents` (Agent Economy), `business` (Autonomous Business), `open` (Open Innovation).

- `security`: supported. Spending limits, a policy engine, an allowlist, human approval, tamper-evident record. This is the core of the repo. (The track page lists function-call keys and TEE attestation as examples; this repo uses neither.)
- `agents`: supported in part. An agent can spend NEAR and call contracts under limits. It does not earn, negotiate or hire, and it does not use Intents or chain signatures.
- `business`: weak fit. There is no treasury, sales, procurement, cross-chain payment or revenue sharing. The owner's call.
- `open`: weak fit. Not an experimental category; the owner's call.

The final choice of tracks is the owner's.

## Checklist (owner values)

- [ ] requestId (UUID, generated once, reused on retries): ______
- [ ] projectName (2-80): ______ (suggestion: warden-near)
- [ ] leadName (2-80): ______
- [ ] email (max 160): ______
- [ ] size (`1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+`): ______
- [ ] tracks (ids, each once): ______
- [ ] nearAddress (mainnet payout account, 2-64, lowercase): ______
- [ ] projectUrl (public repo, max 300): https://github.com/isiomaC/warden-near
- [ ] demoUrl (public X post, max 300; says built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, video or screenshots): ______
- [ ] idea (20-2000): text above
- [ ] consent (true, only after the owner agrees to: "I agree that the organizers may use these details to review our submission and contact us about this hackathon."): ______

Before the deadline (2026-11-14T23:59:00Z): repo public, README "Prior work" section present, CI green.
