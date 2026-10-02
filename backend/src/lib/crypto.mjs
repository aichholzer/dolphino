import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 3;
const KEY_CONTEXT = 'dolphino/settings/key/v3/AES-256-GCM credential encryption';
const fail = () =>
  Object.assign(new Error('Encrypted credentials unavailable; verify APP_SECRET or replace credentials'), {
    status: 409
  });

function validateSecret(secret) {
  // Reject common placeholders and short/low-diversity inputs. Operators must generate random material.
  if (
    typeof secret !== 'string' ||
    secret.length < 43 ||
    new Set(secret).size < 12 ||
    /example|changeme|replace|your.secret/i.test(secret)
  ) {
    throw fail();
  }
}

function key(secret, salt) {
  validateSecret(secret);
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), salt, Buffer.from(KEY_CONTEXT), 32));
}

function associatedData(setting, provider) {
  return Buffer.from(JSON.stringify(['dolphino-credential', VERSION, setting, provider]));
}

export function canEncrypt(secret) {
  try {
    validateSecret(secret);
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(value, secret, setting, provider) {
  if (typeof value !== 'string' || !value.length) {
    throw fail();
  }

  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret, salt), nonce);
  cipher.setAAD(associatedData(setting, provider));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    v: VERSION,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
}

function decode(value, size) {
  if (typeof value !== 'string' || value.length > 1400000) {
    throw fail();
  }

  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (size ? bytes.length !== size : !bytes.length)) {
    throw fail();
  }

  return bytes;
}

export function decryptSecret(envelope, secret, setting, provider) {
  try {
    // Retired protocols are never reinterpreted or rewritten. Replacement is explicit.
    if (envelope?.v !== VERSION) {
      throw fail();
    }

    const salt = decode(envelope.salt, 32);
    const decipher = createDecipheriv('aes-256-gcm', key(secret, salt), decode(envelope.nonce, 12));
    decipher.setAAD(associatedData(setting, provider));
    decipher.setAuthTag(decode(envelope.tag, 16));
    return Buffer.concat([decipher.update(decode(envelope.data)), decipher.final()]).toString('utf8');
  } catch {
    throw fail();
  }
}
