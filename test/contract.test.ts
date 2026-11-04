import { Worker, type NearAccount } from "near-workspaces";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";

const supported = !(process.platform === "darwin" && process.arch === "x64") && existsSync("build/warden_anchor.wasm"); // near-sandbox has no Darwin x64 binary
let worker: Worker, root: NearAccount, contract: NearAccount, alice: NearAccount;
const H = (c: string) => c.repeat(64);

beforeAll(async () => {
  if (!supported) return;
  worker = await Worker.init();
  root = worker.rootAccount;
  contract = await root.createSubAccount("anchor");
  await contract.deploy("build/warden_anchor.wasm");
  alice = await root.createSubAccount("alice");
}, 120_000);
afterAll(async () => { await worker?.tearDown(); });

test.skipIf(!supported)("anchor stores head and latest returns it", async () => {
  await alice.call(contract, "anchor", { logId: H("a"), entryCount: 2, headHash: H("b") });
  const got: any = await contract.view("latest", { publisher: alice.accountId, logId: H("a") });
  expect(got.entryCount).toBe(2);
  expect(got.headHash).toBe(H("b"));
});

test.skipIf(!supported)("count must strictly increase (truncated log cannot replace a newer anchor)", async () => {
  await alice.call(contract, "anchor", { logId: H("c"), entryCount: 3, headHash: H("d") });
  await expect(alice.call(contract, "anchor", { logId: H("c"), entryCount: 3, headHash: H("e") })).rejects.toThrow(/NotAnAdvance/);
  await expect(alice.call(contract, "anchor", { logId: H("c"), entryCount: 2, headHash: H("e") })).rejects.toThrow(/NotAnAdvance/);
  await alice.call(contract, "anchor", { logId: H("c"), entryCount: 4, headHash: H("e") });
});

test.skipIf(!supported)("empty log and malformed hashes are rejected", async () => {
  await expect(alice.call(contract, "anchor", { logId: H("f"), entryCount: 0, headHash: H("1") })).rejects.toThrow(/EmptyLog/);
  await expect(alice.call(contract, "anchor", { logId: H("f"), entryCount: 1, headHash: "0xabc" })).rejects.toThrow(/headHash/);
});

test.skipIf(!supported)("anchors are keyed by the signing account", async () => {
  const bob = await root.createSubAccount("bob");
  await bob.call(contract, "anchor", { logId: H("a"), entryCount: 1, headHash: H("9") });
  const a: any = await contract.view("latest", { publisher: alice.accountId, logId: H("a") });
  const b: any = await contract.view("latest", { publisher: bob.accountId, logId: H("a") });
  expect(a.headHash).toBe(H("b"));
  expect(b.headHash).toBe(H("9"));
  expect(await contract.view("latest", { publisher: bob.accountId, logId: H("0") })).toBeNull();
});
