import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";

export interface Chain {
  readonly accountId: string;
  readonly network: string;
  getBalance(accountId?: string): Promise<bigint>;
  transfer(receiver: string, yocto: bigint): Promise<{ txHash: string }>;
  call(contract: string, method: string, args: Record<string, unknown>, depositYocto: bigint): Promise<{ txHash: string }>;
  view(contract: string, method: string, args: Record<string, unknown>): Promise<unknown>;
}

const RPC = { testnet: "https://test.rpc.fastnear.com" } as const;

/** NEAR testnet through near-api-js. Mainnet is refused on purpose. */
export function testnetChain(env: NodeJS.ProcessEnv = process.env): Chain {
  const accountId = env.NEAR_ACCOUNT_ID, key = env.NEAR_PRIVATE_KEY;
  if (!accountId || !key) throw new Error("Set NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY (run `pnpm setup:testnet`).");
  if ((env.NEAR_NETWORK ?? "testnet") !== "testnet") throw new Error("Testnet only.");
  const provider = new JsonRpcProvider({ url: env.NEAR_RPC_URL ?? RPC.testnet });
  const account = new Account(accountId, provider, KeyPairSigner.fromSecretKey(key as `ed25519:${string}`));
  return {
    accountId, network: "testnet",
    getBalance: async (id = accountId) => (await provider.viewAccount({ accountId: id })).amount,
    transfer: async (receiverId, amount) => ({ txHash: (await account.transfer({ receiverId, amount })).transaction.hash }),
    call: async (contractId, methodName, args, deposit) => ({
      txHash: (await account.callFunctionRaw({ contractId, methodName, args, deposit, gas: 100_000_000_000_000n })).transaction.hash,
    }),
    view: (contractId, method, args) => provider.callFunction({ contractId, method, args }),
  };
}

/** In-memory stand-in so the demo and tests run offline. Same interface, no network. */
export function mockChain(accountId = "agent.mock.testnet"): Chain & { sent: unknown[] } {
  const balances = new Map<string, bigint>([[accountId, 5n * 10n ** 24n]]);
  const sent: unknown[] = [];
  let n = 0;
  const tx = () => ({ txHash: `MOCKTX${String(++n).padStart(4, "0")}` });
  return {
    accountId, network: "mock", sent,
    getBalance: async (id = accountId) => balances.get(id) ?? 0n,
    transfer: async (to, y) => {
      balances.set(accountId, (balances.get(accountId) ?? 0n) - y);
      balances.set(to, (balances.get(to) ?? 0n) + y);
      sent.push({ transfer: to, y: y.toString() });
      return tx();
    },
    call: async (c, m, a, d) => { sent.push({ call: c, m, a, d: d.toString() }); return tx(); },
    view: async (c, m) => ({ mock: true, contract: c, method: m }),
  };
}
