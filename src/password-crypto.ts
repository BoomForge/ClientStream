/** PBKDF2-SHA256, 32 bytes. Compatible with the previously stored Node PBKDF2 hashes. */
export const WORKER_PBKDF2_MAX_ITERATIONS = 100_000;

export async function derivePassword(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > WORKER_PBKDF2_MAX_ITERATIONS) {
    throw new RangeError("PBKDF2 iteration count is outside supported Worker range.");
  }
  // Worker-native Web Crypto avoids relying on Node's callback implementation.
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new Uint8Array(salt), hash: "SHA-256", iterations },
    keyMaterial,
    256
  );
  return new Uint8Array(derived);
}
