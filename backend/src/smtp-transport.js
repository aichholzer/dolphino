import { z } from 'zod';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import { publicSmtpAddress } from './smtp-network.js';

// Shared by invitation mail and budget notifications. Keep network validation,
// address pinning, TLS policy and redacted delivery failures in one transport.
const invalid = () => Object.assign(Error('Invalid notification settings'), { status: 400 });
export const smtpEmailSchema = z
  .string()
  .max(254)
  .email()
  .refine((v) => !/[\r\n]/.test(v));

export function smtpOptions(value) {
  try {
    const url = new URL(value);
    if (
      !['smtp:', 'smtps:'].includes(url.protocol) ||
      url.search ||
      url.hash ||
      (url.pathname && url.pathname !== '/') ||
      !url.hostname ||
      isIP(url.hostname) ||
      url.hostname.includes(':') ||
      !/^[a-z0-9.-]+$/i.test(url.hostname) ||
      !url.hostname.includes('.') ||
      /(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/i.test(url.hostname) ||
      url.hostname.endsWith('.') ||
      !url.username ||
      !url.password ||
      /[\r\n]/.test(value)
    ) {
      throw invalid();
    }
    const port = Number(url.port || (url.protocol === 'smtps:' ? 465 : 587));
    if (![465, 587, 2525].includes(port)) {
      throw invalid();
    }
    if ((port === 465) !== (url.protocol === 'smtps:')) {
      throw invalid();
    }
    return {
      host: url.hostname,
      port,
      secure: url.protocol === 'smtps:',
      requireTLS: true,
      opportunisticTLS: false,
      ignoreTLS: false,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      auth: {
        user: decodeURIComponent(url.username),
        pass: decodeURIComponent(url.password)
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
      dnsTimeout: 10000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      pool: false
    };
  } catch {
    throw invalid();
  }
}
export async function sendSmtp(
  { smtpUrl, from, to, text, messageId, subject = 'Dolphino budget notification' },
  createTransport = nodemailer.createTransport,
  lookupImpl = lookup
) {
  if (!smtpEmailSchema.safeParse(from).success || !smtpEmailSchema.safeParse(to).success) {
    throw invalid();
  }
  if (typeof subject !== 'string' || subject.length > 150 || /[\r\n]/.test(subject)) {
    throw invalid();
  }
  const options = smtpOptions(smtpUrl);
  let transport;
  let timer;
  try {
    const addresses = await Promise.race([
      lookupImpl(options.host, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('DNS timeout')), 10000);
      })
    ]);
    clearTimeout(timer);
    if (!addresses.length || addresses.some(({ address }) => !publicSmtpAddress(address))) {
      throw invalid();
    }
    // Pin the checked IP; a second DNS lookup cannot redirect SMTP into the LAN.
    // Keep the original DNS name for SNI and certificate hostname verification.
    transport = createTransport({
      ...options,
      host: addresses[0].address,
      servername: options.host,
      tls: { ...options.tls, servername: options.host }
    });
    await Promise.race([
      transport.sendMail({
        from,
        to,
        subject,
        text,
        messageId,
        disableFileAccess: true,
        disableUrlAccess: true
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          transport.close();
          reject(Error('timeout'));
        }, 20000);
      })
    ]);
  } catch {
    throw Object.assign(Error('SMTP delivery failed; verify configuration and provider availability'), { status: 502 });
  } finally {
    clearTimeout(timer);
    transport?.close();
  }
}
