// Creates two throwaway TESTNET accounts through the NEAR faucet service (no funds or secrets needed from you):
//   contract account (holds the WardenAnchor contract) and wallet account (the agent's wallet and anchor publisher).
// Keys are generated locally and written to .env (git-ignored, mode 600). Only public info is printed.
import { execFileSync } from "node:child_process";
import { existsSync, appendFileSync } from "node:fs";
import { KeyPair } from "near-api-js";

if (existsSync(".env") && /NEAR_ACCOUNT_ID=/.test(await import("node:fs").then((f) => f.readFileSync(".env", "utf8")))) {
  console.log(".env already has NEAR_ACCOUNT_ID, refusing to overwrite. Delete it to start over.");
  process.exit(0);
}
const suffix = Math.random().toString(36).slice(2, 8);
const mk = (name: string) => {
  const id = `${name}-${suffix}.testnet`;
  const key = KeyPair.fromRandom("ed25519");
  execFileSync(
    "node_modules/.bin/near",
    ["account", "create-account", "sponsor-by-faucet-service", id, "use-manually-provided-public-key", key.getPublicKey().toString(), "network-config", "testnet", "create"],
    { stdio: "inherit" },
  );
  return { id, key: key.toString() };
};
const contract = mk("warden-anchor");
const wallet = mk("warden-agent");
appendFileSync(
  ".env",
  `NEAR_NETWORK=testnet\nNEAR_CONTRACT_ID=${contract.id}\nNEAR_CONTRACT_PRIVATE_KEY=${contract.key}\nNEAR_ACCOUNT_ID=${wallet.id}\nNEAR_PRIVATE_KEY=${wallet.key}\n`,
  { mode: 0o600 },
);
console.log({ contract: contract.id, wallet: wallet.id, wrote: ".env (secret keys inside, not printed)" });
