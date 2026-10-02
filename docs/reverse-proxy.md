# Reverse proxies and client addresses

`TRUST_PROXY` is an optional comma-separated allowlist of proxy IP addresses or CIDR ranges. An unset or empty value adds no network proxies. IPv4 loopback (`127.0.0.0/8`), IPv6 loopback (`::1`) and equivalent IPv4-mapped addresses are always trusted. Local processes can therefore supply forwarding headers; keep the application host and its loopback listeners under your control.

Use exact proxy addresses where possible. Both IPv4 and IPv6 are supported. Hostnames, URLs, ports, bracketed IPv6, zone IDs, empty list entries, `true`, `*` and named ranges are rejected at startup. Configuration is limited to 64 entries and 4096 characters. Do not use all-address ranges such as `0.0.0.0/0` or `::/0`, or trust an entire LAN merely because it is private: every allowed source can assert client addresses.

## cloudflared → Caddy → Dolphino

For this topology, **Dolphino's immediate trusted peer is Caddy**, even when cloudflared is the internet-facing entry point. With Caddy on a different LAN host or container, set `TRUST_PROXY` to the Caddy source address actually observed by the application. A container bridge or source NAT may change that address. Do not substitute the browser's IP, a public hostname, the tunnel's public endpoint or a guessed address.

This is a documentation-only example using a reserved TEST-NET address, not a deployment value:

```dotenv
# Replace with the verified immediate Caddy peer before deploying.
TRUST_PROXY=192.0.2.10
```

Check the forwarding chain delivered by Caddy before adding any other entries:

- If Caddy sends one validated client address in `X-Forwarded-For`, trusting Caddy alone is sufficient
- If Caddy sends `client, cloudflared-peer`, the application walks through Caddy and then stops at `cloudflared-peer` unless that upstream hop is also explicitly trusted
- Add an upstream hop only when it is your verified proxy and Caddy receives a trustworthy chain from it. Prefer exact addresses or narrowly scoped proxy subnets
- Any untrusted intermediate hop becomes the resolved client. Addresses farther left cannot override it

Caddy's trust configuration is separate from Dolphino's. Caddy ignores incoming forwarding-header values by default, and its `trusted_proxies` configuration controls which upstream sources may supply them. Configure that boundary for the actual cloudflared connection, and ensure the edge does not preserve spoofed client values as authoritative. See [Caddy's forwarding-header guidance](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults) and [trusted proxy options](https://caddyserver.com/docs/caddyfile/options#trusted-proxies). Changing Dolphino's allowlist cannot repair an incorrect upstream trust boundary.

`APP_BIND` continues to control the published application interface in Compose. A separate-host Caddy needs a reachable interface, but binding an interface does not grant proxy trust or restrict who can connect. Use the deployment's network/firewall controls to restrict direct application access appropriately. If NAT makes untrusted clients appear to share Caddy's allowed source address, the application cannot distinguish them; fix that network boundary rather than widening the allowlist. No LAN, Caddy or cloudflared address is assumed by Dolphino.

## Request resolution and failure behavior

The shared HTTP boundary sets `req.clientIp` before authentication and route handlers. Authentication rate limits use the same resolver, including direct service calls, and request-aware logging/audit code can consume the same normalized value. Existing security-audit storage is unchanged and does not add an IP field.

Resolution starts from the actual socket peer:

1. An untrusted peer's forwarding headers are ignored entirely
2. For a trusted peer, only `X-Forwarded-For` is considered. `Forwarded`, `X-Real-IP`, `CF-Connecting-IP` and `True-Client-IP` are never used directly
3. The entire header must contain valid, bare IP literals separated by commas, with optional spaces/tabs. The maximum is 4096 UTF-8 bytes and 32 forwarded addresses
4. Starting at the immediate peer, walk the chain right to left only while the current hop is trusted. Stop at the first untrusted address; if all hops are trusted, use the leftmost supplied address
5. An absent, malformed, oversized or overlong chain falls back to the socket peer without truncating or skipping bad entries. An invalid/missing socket address resolves to `unknown`; headers cannot supply a replacement

IPv6 spelling is canonicalized, and IPv4-mapped IPv6 is normalized to IPv4 so alternate spellings cannot create new authentication-limit buckets. A malformed chain conservatively shares the proxy's authentication limit. The existing per-action limit for sensitive administrator operations remains shared across the app; proxy trust does not relax it. Client IP does not replace session authorization or the exact `APP_ORIGIN` requirement.

Before a live rollout, verify the actual peer and header chain in a controlled environment, then check both normal requests and requests with attacker-supplied forwarding headers. The repository tests exercise synthetic peers and HTTP requests without contacting any real proxy or changing deployment configuration:

```sh
node --test backend/test/client-ip.test.mjs backend/test/http-boundary.test.mjs
```
