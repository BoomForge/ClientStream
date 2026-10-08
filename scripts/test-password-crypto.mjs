import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { derivePassword, WORKER_PBKDF2_MAX_ITERATIONS } from "../src/password-crypto.ts";

// Verify the Worker-native path produces byte-identical hashes to previously
// stored Node PBKDF2-SHA256 credentials (including Unicode and production cost).
for (const { password, salt, iterations } of [
  { password: "legacy-password", salt: Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]), iterations: 1 },
  { password: "Unicode-pässwörd-🔒", salt: Uint8Array.from([6, 7, 8, 9, 1, 2, 3, 4]), iterations: 100_000 }
]) {
  const expected = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const actual = await derivePassword(password, salt, iterations);
  assert.deepEqual(Buffer.from(actual), expected);
}
assert.equal(WORKER_PBKDF2_MAX_ITERATIONS, 100_000);
await assert.rejects(() => derivePassword("password", new Uint8Array(16), 100_001), RangeError);
console.log("Worker-native PBKDF2 matches stored hashes and enforces Cloudflare's 100k iteration ceiling.");
