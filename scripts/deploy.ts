// Deploys build/warden_anchor.wasm to the testnet contract account from .env.
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";

const { NEAR_CONTRACT_ID: id, NEAR_CONTRACT_PRIVATE_KEY: key } = process.env;
if (!id || !key) throw new Error("Run `pnpm setup:testnet` first.");
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com" });
const account = new Account(id, provider, KeyPairSigner.fromSecretKey(key as `ed25519:${string}`));
const res = await account.deployContract(readFileSync("build/warden_anchor.wasm"));
console.log({ contract: id, deployTx: res.transaction.hash, explorer: `https://explorer.testnet.near.org/transactions/${res.transaction.hash}` });
