// AES-256-GCM encryption for Schwab OAuth tokens at rest. TOKEN_ENCRYPTION_KEY
// is a 32-byte key, hex-encoded, in .env — generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Losing/rotating this key invalidates every stored token; affected users
// would just need to reconnect Schwab (click "Connect Schwab" again).
import crypto from "crypto";

const KEY = process.env.TOKEN_ENCRYPTION_KEY ? Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, "hex") : null;

function requireKey() {
  if (!KEY || KEY.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is missing or not a 32-byte hex string — generate one and set it in .env."
    );
  }
  return KEY;
}

export function encryptToken(plaintext) {
  const key = requireKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store iv + authTag + ciphertext together, base64, as one column value.
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptToken(stored) {
  const key = requireKey();
  const raw = Buffer.from(stored, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
