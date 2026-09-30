import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const fail = () =>
  Object.assign(
    new Error(
      "Encrypted credentials unavailable; verify APP_SECRET or replace credentials",
    ),
    { status: 409 },
  );
function key(secret, salt, version = 1) {
  // Reject common placeholders and short/low-diversity inputs. Operators must generate random material.
  if (
    typeof secret !== "string" ||
    secret.length < 43 ||
    new Set(secret).size < 12 ||
    /example|changeme|replace|your.secret/i.test(secret)
  )
    throw fail();
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      version === 1 ? Buffer.from("profe/settings/key/v1") : salt,
      Buffer.from(
        version === 1
          ? "AES-256-GCM credential encryption"
          : "profe/settings/key/v2/AES-256-GCM credential encryption",
      ),
      32,
    ),
  );
}
export function canEncrypt(secret) {
  try {
    key(secret);
    return true;
  } catch {
    return false;
  }
}
export function encryptSecret(value, secret, setting, provider) {
  if (typeof value !== "string" || !value.length) throw fail();
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret, salt, 2), nonce);
  cipher.setAAD(
    Buffer.from(JSON.stringify(["profe-credential", 2, setting, provider])),
  );
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    v: 2,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}
function decode(value, size) {
  if (typeof value !== "string" || value.length > 1400000) throw fail();
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64") !== value ||
    (size ? bytes.length !== size : !bytes.length)
  )
    throw fail();
  return bytes;
}
export function decryptSecret(envelope, secret, setting, provider) {
  try {
    if (![1, 2].includes(envelope?.v)) throw fail();
    const salt = envelope.v === 2 ? decode(envelope.salt, 32) : undefined;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(secret, salt, envelope.v),
      decode(envelope.nonce, 12),
    );
    decipher.setAAD(
      Buffer.from(
        JSON.stringify(["profe-credential", envelope.v, setting, provider]),
      ),
    );
    decipher.setAuthTag(decode(envelope.tag, 16));
    return Buffer.concat([
      decipher.update(decode(envelope.data)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw fail();
  }
}
