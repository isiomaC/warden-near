const YOCTO = 10n ** 24n;

/** "1.5" NEAR -> yoctoNEAR. Strict: digits with up to 24 decimals, nothing else. */
export function toYocto(near: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(near);
  if (!m) throw new Error(`invalid NEAR amount: ${JSON.stringify(near)}`);
  return BigInt(m[1]!) * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0"));
}

export function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO;
  const frac = (yocto % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
