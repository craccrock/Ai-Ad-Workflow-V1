import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

const PREFIX = "mgs_";

/** Returns the plaintext key (shown once) plus what we persist. */
export function generateApiKey() {
  const key = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, PREFIX.length + 6) };
}

/** HMAC-SHA256 with a server-side salt: a leaked DB row can't be brute-forced offline without the salt. */
export function hashApiKey(key: string) {
  return createHmac("sha256", env.apiSecretSalt).update(key).digest("hex");
}

export function looksLikeApiKey(value: string) {
  return value.startsWith(PREFIX) && value.length > PREFIX.length + 20;
}

export function safeEqualHex(a: string, b: string) {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
