# Verified facts

Checked on 2026-11-04. "Ran" means I executed it in this repository; "Docs" means read on the NEAR docs site only.

## Verified

| Fact | How |
| --- | --- |
| `@stlw/warden@0.2.9` and `@stlw/warden-cli@0.2.9` exist on npm, MIT | `npm view` |
| Function-call access keys sign calls to one `receiver_id`, optional `method_names`, optional gas `allowance`; they cannot attach a deposit, so cannot move NEAR. Full-access keys can transfer. | Docs: docs.near.org/protocol/access-keys |
| `near-api-js` latest is 7.4.0; `Account`, `JsonRpcProvider`, `KeyPairSigner`, `account.transfer`, `account.callFunctionRaw`, `provider.callFunction`, `provider.viewAccount`, `account.deployContract` exist and work | Docs + ran (transfers, contract calls, deploy, view on testnet) |
| Testnet RPC `https://test.rpc.fastnear.com` | Docs, ran |
| `near-cli-rs` (npm `near-cli-rs` 0.30.1) can create a funded testnet account through a faucet service with no owner funds or keys: `near account create-account sponsor-by-faucet-service <id> use-manually-provided-public-key <pub> network-config testnet create` | Ran (`scripts/setup-testnet.ts`); accounts came back with 10 NEAR |
| `near-sdk-js` 2.0.0 builds a TypeScript contract to wasm (`near-sdk-js build`) and the contract works on testnet (`anchor`, `latest`, count must increase) | Ran |
| NEAR Hackathon: submissions close 14 Nov 2026 23:59 UTC; required items are working prototype, public repo, public X post (says built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, demo video or screenshots), form with repo link and post link. Claude Code and Codex screen first. One submission, several tracks allowed. | Read nearhackathon.com |
| Warden's YAML policy (`warden proxy`/gateway) matches on tool names, environment, trust and regex over the JSON input. It has no numeric comparison. Warden's embedding API (`createWarden`, `definePolicy`, custom conditions and resolvers, `PENDING_APPROVAL`, `AuditChain`, `createApprovalRequest`) does. | Read Warden 0.2.9 source and docs/EMBEDDING.md, ran |

## Could not verify, or verified with caveats

| Item | Status |
| --- | --- |
| nearhackathon.com on code that existed before the hackathon | The page only says "Code written since the announcement counts" and does not define the announcement date or say how earlier code is treated. This repo discloses Warden and warden-anchor as prior work and was created on 4 Nov 2026. |
| `near-sdk-js` maintenance | Last npm release 2.0.0 (June 2024). The NEAR smart-contract quickstart names `near-sdk-rs` "NEAR's only official smart-contract SDK". The JS SDK still built and ran here, but treat it as unmaintained. |
| `near-sdk-js` install | Pnpm did not run its postinstall (it downloads QuickJS, wasi-sdk and binaryen, the binaryen one from a personal GitHub release). `pnpm build:contract` runs it for you via `scripts/build-contract.sh`. |
| Sandbox contract tests (`near-workspaces`) | `near-sandbox` has no Darwin x64 binary ("Unsupported platform: Darwin x64"), so `test/contract.test.ts` is skipped on an Intel Mac. They run on Linux in GitHub Actions and pass there (run 41801864893); they were NOT executed on the author's machine. The contract was instead exercised on real testnet (`pnpm demo -- --testnet`). |
| Adding a function-call key with near-api-js | `Account.addFunctionCallAccessKey` exists in the 7.4.0 types, but I did not run it and this repo does not use it. The docs page for near-cli did not document adding function-call keys or sub-accounts. |
| docs.near.org/protocol/account-model | Returned 404; sub-account rules were not read. |
| Explorer URL | `explorer.testnet.near.org` is what near-cli-rs prints; I did not open it in a browser. |
| Mainnet | Not touched, not needed. The code refuses `NEAR_NETWORK` other than testnet. |
