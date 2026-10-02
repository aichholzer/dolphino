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
    'The Telegram group changed its identity. Pair and confirm the new group before sending alerts.'
});

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
