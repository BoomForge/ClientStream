/** PBKDF2-SHA256, 32 bytes. Compatible with the previously stored Node PBKDF2 hashes. */
export async function derivePassword(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
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
