import { Agent, EnvHttpProxyAgent } from 'undici';

// A high-latency route may need longer than Node's 250 ms default to finish a
// TCP handshake before family fallback abandons it. Scope this to Telegram;
// never change net defaults or the process-wide fetch dispatcher.
const connect = Object.freeze({
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 2000,
  rejectUnauthorized: true
});
let dispatcher;

function environmentProxyEnabled() {
  // Honor Node's existing startup opt-in. NODE_OPTIONS supports double-quoted
  // tokens; explicit command-line flags follow and override environment flags.
  const environmentFlags = (process.env.NODE_OPTIONS || '').match(/(?:[^\s"]|"(?:\\.|[^"])*")+/g) || [];
  const flags = [...environmentFlags.map((flag) => flag.replace(/^"|"$/g, '')), ...process.execArgv];
  let enabled = process.env.NODE_USE_ENV_PROXY === '1';
  for (const flag of flags) {
    if (flag === '--use-env-proxy') {
      enabled = true;
    } else if (flag === '--no-use-env-proxy') {
      enabled = false;
    }
  }

  return enabled;
}

export function telegramDispatcher() {
  dispatcher ||= environmentProxyEnabled()
    ? new EnvHttpProxyAgent({ connect, requestTls: connect, proxyTls: connect })
    : new Agent({ connect });
  return dispatcher;
}
