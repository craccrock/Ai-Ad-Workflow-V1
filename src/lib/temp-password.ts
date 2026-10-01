import "server-only";
import { randomInt } from "node:crypto";

// No look-alike characters (0/O, 1/l/I), so passwords survive being read aloud or retyped.
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** e.g. "k7Qm-Xp3v-9aRt-hW2e" — 16 random chars (~92 bits), grouped for readability. */
export function generateTempPassword() {
  const chars = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}
