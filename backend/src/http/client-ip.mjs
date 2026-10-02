import { BlockList, isIP } from 'node:net';

const MAX_TRUST_PROXY_LENGTH = 4096;
const MAX_TRUSTED_PROXIES = 64;
export const MAX_FORWARDED_FOR_LENGTH = 4096;

export const MAX_FORWARDED_HOPS = 32;

function addressFamily(address) {
  // Zone IDs, ports and brackets are not part of a forwarded IP literal.
  return typeof address === 'string' && !address.includes('%') ? isIP(address) : 0;
}

function canonicalAddress(address) {
  const family = addressFamily(address);
  if (family === 4) {
    return address;
  }

  if (family !== 6) {
    return null;
  }

  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  // Equivalent IPv4 and mapped-IPv6 spellings must share authentication limits.
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
  if (mapped) {
    const high = parseInt(mapped[1], 16),
      low = parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }

  return normalized;
}

function proxyEntry(entry) {
  const parts = entry.split('/');
  const family = addressFamily(parts[0]);
  if (!family || parts.length > 2) {
    throw Error('TRUST_PROXY entries must be IP addresses or CIDR ranges');
  }

  const prefix = parts.length === 2 ? Number(parts[1]) : null;
  if (prefix !== null && (!/^(0|[1-9][0-9]{0,2})$/.test(parts[1]) || prefix > (family === 4 ? 32 : 128))) {
    throw Error('TRUST_PROXY contains an invalid CIDR prefix');
  }

  return { address: parts[0], family: family === 4 ? 'ipv4' : 'ipv6', prefix };
}

export function parseTrustedProxies(value = '') {
  if (typeof value !== 'string' || value.length > MAX_TRUST_PROXY_LENGTH) {
    throw Error('TRUST_PROXY must be a comma-separated IP/CIDR list of at most 4096 characters');
  }

  if (!value.trim()) {
    return Object.freeze([]);
  }

  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length > MAX_TRUSTED_PROXIES) {
    throw Error('TRUST_PROXY must contain at most 64 entries');
  }

  for (const entry of entries) {
    proxyEntry(entry);
  }

  return Object.freeze([...new Set(entries)]);
}

// A trust decision always begins with the actual TCP peer, never a request header.
export function createClientIpResolver(trustedProxies = []) {
  if (!Array.isArray(trustedProxies) || trustedProxies.some((entry) => typeof entry !== 'string')) {
    throw new TypeError('Trusted proxies must be a parsed IP/CIDR list');
  }

  const trusted = new BlockList();
  trusted.addSubnet('127.0.0.0', 8, 'ipv4');
  trusted.addAddress('::1', 'ipv6');
  for (const entry of parseTrustedProxies(trustedProxies.join(','))) {
    const { address, family, prefix } = proxyEntry(entry);
    if (prefix === null) {
      trusted.addAddress(address, family);
    } else {
      trusted.addSubnet(address, prefix, family);
    }
  }

  const isTrusted = (address) => trusted.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
  return function resolveClientIp(req) {
    const peer = canonicalAddress(req.socket?.remoteAddress);
    if (!peer) {
      return 'unknown';
    }

    if (!isTrusted(peer)) {
      return peer;
    }

    const forwarded = req.headers?.['x-forwarded-for'];
    if (
      typeof forwarded !== 'string' ||
      !forwarded ||
      forwarded.length > MAX_FORWARDED_FOR_LENGTH ||
      Buffer.byteLength(forwarded, 'utf8') > MAX_FORWARDED_FOR_LENGTH
    ) {
      return peer;
    }

    const entries = forwarded.split(',');
    if (entries.length > MAX_FORWARDED_HOPS) {
      return peer;
    }

    const addresses = entries.map((entry) => canonicalAddress(entry.replace(/^[ \t]+|[ \t]+$/g, '')));
    // Reject the whole ambiguous chain, rather than skipping invalid elements.
    if (addresses.some((address) => !address)) {
      return peer;
    }

    let client = peer;
    for (let index = addresses.length - 1; index >= 0 && isTrusted(client); index--) {
      client = addresses[index];
    }

    return client;
  };
}
