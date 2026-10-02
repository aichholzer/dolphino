// Only fixed application-owned messages cross the HTTP boundary. Telegram's
// description, response body, request URL and transport exception stay private.
const messages = Object.freeze({
  telegram_token_required: 'Save a Telegram bot token in notification settings before pairing a group.',
  telegram_token_invalid:
    'The saved Telegram bot token has an invalid format. Copy the full token from BotFather and save it again.',
  telegram_token_rejected:
    'Telegram rejected the saved bot token. Check it in BotFather, save the current token, then pair again.',
  telegram_access_denied:
    'Telegram refused this bot operation. Check that the bot can access the private group and has not been removed or blocked.',
  telegram_unreachable:
    'Dolphino could not reach Telegram. Check the server’s outbound HTTPS access to api.telegram.org and try again.',
  telegram_dns_failed:
    'Dolphino could not resolve the Telegram connection hostname. Check DNS from inside the app container; the failure may also be at a configured proxy.',
  telegram_tls_failed:
    'Dolphino could not establish verified TLS with Telegram. Check the app container’s clock and Node certificate/proxy configuration. TLS verification remains required.',
  telegram_timeout:
    'The Telegram request timed out. Check connectivity from Node inside the app container, including IPv4/IPv6 routing and any configured proxy.',
  telegram_connection_refused:
    'The Telegram connection was refused. Check the app container’s HTTPS route and any configured proxy.',
  telegram_network_unreachable:
    'Node reported an unreachable network or host while connecting to Telegram. Check IPv4/IPv6 routing from inside the app container.',
  telegram_connection_closed:
    'The Telegram connection closed before the response completed. Check the app container’s network or proxy, then try pairing again.',
  telegram_response_invalid:
    'Telegram returned an unexpected response. Try again shortly; if this continues, check the server’s network or proxy configuration.',
  telegram_request_failed:
    'Telegram could not complete this operation. Try again shortly and check the bot’s access to the private group.',
  telegram_polling_conflict:
    'Another service is polling this Telegram bot. Stop that poller or use a dedicated bot, then check for the group again.',
  telegram_rate_limited: 'Telegram is limiting requests. Wait before trying pairing again.',
  telegram_existing_webhook_refused:
    'This bot already has a Telegram webhook. Use a dedicated bot or remove its existing integration yourself before pairing; Dolphino will not remove it.',
  telegram_bot_invalid:
    'The saved token did not identify a valid Telegram bot. Check the token in BotFather and save it again.',
  telegram_pairing_expired: 'This pairing request expired or was already used. Start pairing again.',
  telegram_pairing_session_mismatch:
    'Use the same signed-in browser session that started this pairing, or start a new pairing.',
  telegram_token_changed_restart_pairing: 'The bot token changed. Start pairing again with the saved token.',
  telegram_candidate_mismatch:
    'The selected group does not match this pairing request. Check for the group again or restart pairing.',
  telegram_private_group_required:
    'Pair a private Telegram group or supergroup. Public groups and direct messages cannot receive household alerts.',
  telegram_group_changed_restart_pairing:
    'The group changed during pairing. Start pairing again and confirm its current details.',
  telegram_pairing_conflict_restart:
    'The pairing command appeared in more than one group. Start again and send it only in your intended private group.',
  telegram_group_migrated_repair_required:
    'The Telegram group changed its identity. Pair and confirm the new group before sending alerts.',
  telegram_delivery_private_group_required:
    'Telegram delivery stopped: the confirmed group could not be verified as private. Make it private or pair another private group, then retry.',
  telegram_delivery_privacy_unverified:
    'Telegram privacy check failed; no financial message was sent. Check connectivity and bot access to the group before retrying.',
  telegram_delivery_pairing_invalid:
    'Telegram delivery stopped: the saved token does not match a confirmed group. Pair and confirm the intended private group again.'
});

export function telegramDeliveryFailure(error) {
  const code = error?.code;
  return [
    'telegram_delivery_private_group_required',
    'telegram_delivery_privacy_unverified',
    'telegram_delivery_pairing_invalid'
  ].includes(code)
    ? { message: messages[code], terminal: code !== 'telegram_delivery_privacy_unverified' }
    : null;
}

// Node fetch wraps socket/TLS/DNS errors in cause and may aggregate IPv4/IPv6
// attempts. Inspect bounded codes only: never retain or expose the raw error,
// which can contain a bot URL, proxy credentials, addresses or provider text.
export function telegramTransportCode(error, fallback = 'telegram_unreachable') {
  const pending = [error],
    seen = new Set(),
    found = new Set();
  for (let i = 0; pending.length && i < 16; i++) {
    const item = pending.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) {
      continue;
    }

    seen.add(item);
    const code = typeof item.code === 'string' ? item.code : '';
    if (
      code.startsWith('ERR_TLS_') ||
      code.startsWith('ERR_SSL_') ||
      [
        'CERT_HAS_EXPIRED',
        'CERT_NOT_YET_VALID',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'UNABLE_TO_GET_ISSUER_CERT',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        'CERT_SIGNATURE_FAILURE',
        'CERT_REVOKED'
      ].includes(code)
    ) {
      found.add('tls_failed');
    }

    if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA'].includes(code)) {
      found.add('dns_failed');
    }

    if (
      ['TimeoutError', 'AbortError'].includes(item.name) ||
      ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)
    ) {
      found.add('timeout');
    }

    if (code === 'ECONNREFUSED') {
      found.add('connection_refused');
    }

    if (['ENETUNREACH', 'EHOSTUNREACH', 'EHOSTDOWN'].includes(code)) {
      found.add('network_unreachable');
    }

    if (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) {
      found.add('connection_closed');
    }

    pending.push(item.cause);
    if (Array.isArray(item.errors)) {
      pending.push(...item.errors.slice(0, 8));
    }
  }

  // Prefer a concrete TLS/DNS/deadline failure over a failed secondary address.
  const reason = [
    'tls_failed',
    'dns_failed',
    'timeout',
    'connection_refused',
    'network_unreachable',
    'connection_closed'
  ].find((code) => found.has(code));
  return reason ? `telegram_${reason}` : fallback;
}

export async function telegramHttpAction(action) {
  try {
    return await action();
  } catch (error) {
    if (!Object.hasOwn(messages, error?.code)) {
      throw error;
    }

    throw Object.assign(new Error(messages[error.code]), {
      status: error.status || 502,
      expose: true
    });
  }
}
