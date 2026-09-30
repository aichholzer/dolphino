import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password, hash) {
  try {
    const [, salt, value] = hash.split(":");
    const actual = scryptSync(password, salt, 64),
      expected = Buffer.from(value, "hex");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}
export function createAuth(config) {
  const failures = new Map();
  const key = config.sessionSecret || randomBytes(32).toString("hex");
  const sign = (s) => createHmac("sha256", key).update(s).digest("base64url");
  return {
    authenticated(req) {
      if (config.mode === "demo") return true;
      const token = (req.headers.cookie || "")
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("profe_session="))
        ?.slice(14);
      if (!token) return false;
      const [payload, sig] = token.split(".");
      if (!payload || !sig) return false;
      const expected = sign(payload);
      return (
        sig.length === expected.length &&
        timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) &&
        Number(payload.split(":")[0]) > Date.now()
      );
    },
    login(req, password) {
      const ip = req.socket.remoteAddress;
      const now = Date.now();
      const state = failures.get(ip);
      if (state && state.until > now && state.count >= 5)
        return {
          status: 429,
          error: "Too many attempts. Try again in 15 minutes.",
        };
      if (!verifyPassword(password, config.passwordHash)) {
        const next =
          state && state.until > now
            ? state
            : { count: 0, until: now + 900000 };
        next.count++;
        failures.set(ip, next);
        if (failures.size > 10000)
          for (const [k, v] of failures) if (v.until < now) failures.delete(k);
        return { status: 401, error: "Incorrect password" };
      }
      failures.delete(ip);
      const payload = `${now + 43200000}:${randomBytes(24).toString("hex")}`;
      return {
        cookie: `profe_session=${payload}.${sign(payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${config.mode === "live" ? "; Secure" : ""}`,
      };
    },
    logoutCookie: `profe_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${config.mode === "live" ? "; Secure" : ""}`,
  };
}
