# Notifications

Dolphino can send budget alerts by email and Telegram when a budget goes over, recovers or goes over again. Alerts always appear in the app. External delivery is off until an administrator sets it up in **Settings → Notifications**, and runs in live mode only.

## Before you enable delivery

Recipients receive household category totals, whatever their access in the app. Settings asks you to confirm that audience before any channel can be enabled. Choose which fields to include (category, period, overspend and remaining budget) and check the preview. Messages never include account names, transaction descriptions or merchants.

## Email

Enter an SMTP connection URL, a sender address your provider has verified, and up to ten recipients. For Brevo, use your SMTP login and SMTP key, not an API key:

```
smtps://SMTP_LOGIN:SMTP_KEY@smtp-relay.brevo.com:465
```

URL-encode special characters in the login and key. Use `smtps` on port 465, or `smtp` on port 587 or 2525 for STARTTLS. The SMTP server must have a public hostname; relays on your home network are not supported. The same settings send member invitations and password resets.

## Telegram

1. Create a bot with BotFather and keep privacy mode on. Use this bot for Dolphino only: one with a webhook, or polled by another app, cannot be paired.
2. Create a private Telegram group with the people who should receive alerts.
3. Save the bot token, then select **Pair Telegram group** and **Choose group in Telegram**, and pick your group.
4. Back in Dolphino, select **Check for group**, confirm the group's name and ID, then select **Confirm group and enable Telegram alerts**.

If the Telegram link does not work, open **Group link not working? Use a manual command**: add the bot to the group and send the command shown there. A pairing expires after ten minutes. Replacing the bot token removes the pairing.

## Testing

**Send email test** and **Send Telegram test** deliver a synthetic message to the recipients or the confirmed group. It contains no financial data.
