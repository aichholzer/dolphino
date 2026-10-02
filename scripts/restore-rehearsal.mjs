import { readTestPostgresConfig, testPostgresEnv } from '../backend/test/helpers/postgres.mjs';
import { createSimplefinIntegration } from '../backend/src/lib/simplefin.mjs';
// Destructive only to new, randomly named databases created by this script.
// Never accepts an existing source or target database name.
import pg from 'pg';
import { ensureDeploymentMode } from '../backend/src/lib/deployment-mode.mjs';
import assert from 'node:assert/strict';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHouseholdAuth, hashHouseholdPassword } from '../backend/src/lib/household-auth.mjs';
import { createUserManagement } from '../backend/src/lib/users.mjs';
import { ensureAccessSchema } from '../backend/src/lib/access.mjs';
import { createAssistantSettings } from '../backend/src/lib/assistant-settings.mjs';
import { createAssistantUsage } from '../backend/src/lib/assistant-usage.mjs';
import { createSettingsStore } from '../backend/src/lib/settings.mjs';
import { createNotificationIntegration } from '../backend/src/lib/notifications.mjs';
import { createRegistration } from '../backend/src/lib/registration.mjs';
import { createRedbarkSettings } from '../backend/src/lib/redbark-settings.mjs';
import { Store } from '../backend/src/lib/store.mjs';
import { ensureRedbarkSchema } from '../backend/src/lib/worker.mjs';
import { createClassificationIntegration } from '../backend/src/lib/classification.mjs';

// Prefer standard PG* inputs. The legacy rehearsal-only override remains useful
// when a test runner has separate application and administrative databases.
const postgresEnv = testPostgresEnv({
  ...process.env,
  TEST_DATABASE_URL: process.env.REHEARSAL_ADMIN_URL
});
const database = readTestPostgresConfig(postgresEnv);
if (!database) {
  throw Error('Set PGHOST, PGDATABASE, PGUSER and PGPASSWORD for a disposable local PostgreSQL server');
}

if (!['127.0.0.1', 'localhost', '::1'].includes(database.host)) {
  throw Error('Restore rehearsal is restricted to a local test PostgreSQL server');
}

const suffix = randomUUID().replaceAll('-', '');
const source = `dolphino_backup_test_${suffix}`;
const target = `dolphino_restore_test_${suffix}`;
const admin = new pg.Pool(database);
const pools = [];
const created = [];
const backupDir = await mkdtemp(join(tmpdir(), 'dolphino-restore-rehearsal-'));
const env = {
  ...process.env,
  ...postgresEnv,
  PGPASSWORD: database.password
};
delete env.DATABASE_URL;
delete env.DATABASE_URL_FILE;
delete env.TEST_DATABASE_URL;
delete env.PGPASSWORD_FILE;
function connect(name) {
  const pool = new pg.Pool({ ...database, database: name });
  pools.push(pool);
  return pool;
}

async function snapshot(pool) {
  const names = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const tables = {};
  for (const { tablename } of names) {
    assert.match(tablename, /^[a-z_]+$/);
    const { rows } = await pool.query(
      `SELECT row_to_json(t)::text AS row FROM "${tablename}" t ORDER BY row_to_json(t)::text`
    );
    tables[tablename] = rows.map(({ row }) => row);
  }

  return tables;
}

try {
  for (const name of [source, target]) {
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
  }

  const srcPool = connect(source);
  await ensureDeploymentMode(srcPool, 'demo');
  const store = new Store(srcPool, { mode: 'demo' });
  await store.migrate();
  await ensureRedbarkSchema(srcPool);
  await createClassificationIntegration({
    pool: srcPool,
    store,
    config: { mode: 'demo' }
  }).init();
  await srcPool.query(
    "INSERT INTO classification_usage(mode,day,requests) VALUES('demo',(now() AT TIME ZONE 'UTC')::date,3)"
  );
  await store.seedDemo();
  const syntheticMasterKey = randomBytes(32).toString('base64');
  const settings = createSettingsStore({
    pool: srcPool,
    appSecret: syntheticMasterKey
  });
  await settings.init();
  const authConfig = {
    mode: 'live',
    origin: 'https://dolphino.example.invalid',
    bootstrapToken: randomBytes(32).toString('base64')
  };
  const householdAuth = createHouseholdAuth({
    pool: srcPool,
    config: authConfig
  });
  await householdAuth.init();
  await createUserManagement({
    pool: srcPool,
    config: authConfig,
    settings,
    sendMail: async () => {
      throw Error('Email forbidden in restore rehearsal');
    }
  }).init();
  await ensureAccessSchema(srcPool);
  const bootstrap = await householdAuth.bootstrap(
    { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    {
      email: 'restore-admin@example.invalid',
      name: 'Fictional administrator',
      password: 'Synthetic recovery fixture password only',
      bootstrapToken: authConfig.bootstrapToken
    }
  );
  const authRequest = { headers: { cookie: bootstrap.cookie.split(';')[0] } };
  const assistantSettings = createAssistantSettings({
    pool: srcPool,
    appSecret: syntheticMasterKey
  });
  await assistantSettings.init();
  await assistantSettings.save({
    provider: 'openai',
    model: 'synthetic-assistant-model',
    enabled: false,
    dataSharingAcknowledged: false,
    apiKey: 'synthetic-assistant-rehearsal-key',
    dailyRequestsPerUser: 3
  });
  const assistantUsage = createAssistantUsage({ pool: srcPool });
  await assistantUsage.init();
  await assistantUsage.reserveRequest({ userId: bootstrap.user.id, limit: 3 });
  await assistantUsage.reserveRequest({ userId: bootstrap.user.id, limit: 3 });

  const memberId = randomUUID();
  await srcPool.query(
    "INSERT INTO household_users(id,email,name,role,password_hash) VALUES($1,'restore-member@example.invalid','Fictional member','member',$2)",
    [memberId, await hashHouseholdPassword('Synthetic member fixture password only')]
  );
  const inviteHash = createHash('sha256').update(randomBytes(32)).digest('hex');
  await srcPool.query(
    "INSERT INTO household_invitations(email,role,purpose,token_hash,expires_at,delivery_state) VALUES('invite@example.invalid','member','invite',$1,now()+interval '1 day','operator')",
    [inviteHash]
  );
  const grantedAccount = (await store.listAccounts())[0];
  const grantedBudget = (await srcPool.query('SELECT id FROM budgets ORDER BY id LIMIT 1')).rows[0];
  await srcPool.query(
    "INSERT INTO user_account_grants(user_id,mode,account_id,permission) VALUES($1,'demo',$2,'view')",
    [memberId, grantedAccount.id]
  );
  await srcPool.query("INSERT INTO user_budget_grants(user_id,mode,budget_id,permission) VALUES($1,'demo',$2,'edit')", [
    memberId,
    grantedBudget.id
  ]);

  await settings.saveProvider({
    provider: 'openai',
    model: 'synthetic-rehearsal',
    enabled: true,
    autoClassify: false,
    autoApply: false,
    dailyRequestLimit: 7,
    batchSize: 3,
    apiKey: 'synthetic-backup-key'
  });
  const redbarkSettings = createRedbarkSettings({
    pool: srcPool,
    settings,
    appSecret: syntheticMasterKey
  });
  await redbarkSettings.save({
    apiKey: 'synthetic-redbark-rehearsal-key',
    signingSecret: 'synthetic-signing-key',
    version: '2026-10-01.wattle',
    backfillDays: 45
  });
  const beforeRedbarkConfig = await redbarkSettings.getRuntimeConfig();
  const simplefinSourceId = randomUUID();
  const simplefinKey = createHash('sha256').update('synthetic-simplefin-account').digest('hex');
  const simplefinAccess = 'https://synthetic-user:synthetic-access-password@provider.example.com/simplefin';
  await settings.setSecret('simplefin.accessUrl', 'simplefin', simplefinAccess);
  await settings.setValue('simplefin', {
    sourceId: simplefinSourceId,
    revision: randomUUID(),
    enabled: false,
    backfillDays: 30,
    providerHost: 'provider.example.com',
    providerKey: simplefinKey
  });
  await srcPool.query(
    'INSERT INTO simplefin_accounts(source_id,remote_key,identity_key,metadata,local_id,mapped_at) VALUES($1,$2,$2,$3,$4,now())',
    [
      simplefinSourceId,
      simplefinKey,
      {
        key: simplefinKey,
        remoteId: 'synthetic-one',
        name: 'Synthetic provenance account',
        currency: 'AUD'
      },
      grantedAccount.id
    ]
  );
  await srcPool.query("INSERT INTO simplefin_claims(token_hash,outcome) VALUES($1,'claimed')", [simplefinKey]);
  await srcPool.query(
    "INSERT INTO simplefin_jobs(dedupe_key,source_id,remote_key,start_second,end_second,attempts,last_error) VALUES('synthetic-restore-window',$1,$2,1700000000,1700086400,2,'simplefin_http_429')",
    [simplefinSourceId, simplefinKey]
  );
  await srcPool.query('INSERT INTO simplefin_fetches(source_id,remote_key,coverage,raw) VALUES($1,$2,$3,$4)', [
    simplefinSourceId,
    simplefinKey,
    { truncated: true },
    {
      account: {
        id: 'synthetic-one',
        transactions: [{ id: 'synthetic-tx', amount: '-1.23' }]
      }
    }
  ]);
  const beforeSimplefin = await createSimplefinIntegration({
    pool: srcPool,
    store,
    settings,
    config: { mode: 'demo', appSecret: syntheticMasterKey },
    request: async () => {
      throw Error('Provider I/O forbidden in restore rehearsal');
    }
  }).snapshot();

  await createNotificationIntegration({
    pool: srcPool,
    settings,
    mode: 'demo',
    sendTelegram: async () => {
      throw Error('Network calls forbidden in restore rehearsal');
    },
    sendSmtpImpl: async () => {
      throw Error('Network calls forbidden in restore rehearsal');
    }
  }).init();
  await createRegistration({
    pool: srcPool,
    settings,
    config: { mode: 'demo' },
    client: {}
  }).init();
  const extraCredentials = [
    ['notifications.smtp.url', 'smtp', 'smtps://fictional:synthetic-password@smtp.example.invalid:465'],
    ['notifications.telegram.botToken', 'telegram', '123456789:synthetic_rehearsal_token_no_network']
  ];
  for (const [setting, provider, value] of extraCredentials) {
    await settings.setSecret(setting, provider, value);
  }

  await srcPool.query(
    "INSERT INTO webhook_registration(singleton,callback_url,destination_id,state,ping_event_id) VALUES(true,'https://dolphino.example.invalid/api/webhooks/redbark','ed_fictionalbackup','registered','evt_fictionalbackup')"
  );
  const notificationEvent = (await srcPool.query('SELECT id FROM notification_events ORDER BY id LIMIT 1')).rows[0];
  assert.ok(notificationEvent, 'Financial writes must have produced durable notification events');
  await srcPool.query(
    "INSERT INTO notification_outbox(event_id,channel,recipient,status,attempts) VALUES($1,'smtp','fictional@example.invalid','pending',0),($1,'telegram','123456789','sent',1)",
    [notificationEvent.id]
  );
  await srcPool.query('UPDATE notification_events SET scanned_at=now() WHERE id=$1', [notificationEvent.id]);
  await srcPool.query(
    "INSERT INTO redbark_jobs(dedupe_key,params,status,attempts,last_error) VALUES('backfill:synthetic-rehearsal',$1,'queued',1,'provider_http_429')",
    [
      {
        accountId: 'acct_fictionalbackup',
        from: '2026-08-01',
        to: '2026-08-31'
      }
    ]
  );
  const firstAccount = (await store.listAccounts())[0];
  await store.updateAccountSettings(firstAccount.id, {
    label: 'Fictional local label',
    description: 'Retained during restore'
  });
  const transaction = (await store.listTransactions()).find((t) => t.status === 'posted' && t.kind === 'expense');
  await store.correctTransaction(transaction.id, {
    category: 'Restore verification',
    note: 'Fictional backup rehearsal correction'
  });
  await store.saveRule({
    contains: 'FICTIONAL BACKUP MATCH',
    category: 'Restore verification',
    priority: 5
  });
  const body = Buffer.from(
    JSON.stringify({
      id: 'fictional-backup-event',
      type: 'transactions.synced'
    })
  );
  await srcPool.query('INSERT INTO redbark_receipts(event_id,body,body_hash) VALUES($1,$2,$3)', [
    'fictional-backup-event',
    body,
    createHash('sha256').update(body).digest('hex')
  ]);
  await srcPool.query("INSERT INTO redbark_jobs(dedupe_key) VALUES('fictional-backup-job')");
  await srcPool.query(
    "INSERT INTO redbark_fetches(account_id,fetched_at,raw) VALUES('fictional-backup-account',now(),'{\"fictional\":true}')"
  );
  await srcPool.query(
    "INSERT INTO classification_jobs(mode,transaction_id,fingerprint) VALUES('demo',$1,'fictional-backup-fingerprint')",
    [transaction.id]
  );
  const months = [...new Set((await store.listTransactions()).map((t) => t.date.slice(0, 7)))].sort();
  const beforeReports = await Promise.all(months.map((month) => store.report({ month, currency: 'AUD' })));
  const before = await snapshot(srcPool);
  console.log(
    execFileSync('sh', [resolve('scripts/backup.sh'), backupDir], {
      env: { ...env, PGDATABASE: source },
      encoding: 'utf8'
    }).trim()
  );
  const dumps = (await readdir(backupDir)).filter((n) => n.endsWith('.dump'));
  assert.equal(dumps.length, 1);
  console.log(
    execFileSync('sh', [resolve('scripts/restore.sh'), join(backupDir, dumps[0])], {
      env: { ...env, PGDATABASE: target, DOLPHINO_RESTORE_CONFIRM: target },
      encoding: 'utf8'
    }).trim()
  );
  const dstPool = connect(target);
  const restored = new Store(dstPool, { mode: 'demo' });

  const restoredAssistantSettings = createAssistantSettings({
    pool: dstPool,
    appSecret: syntheticMasterKey
  });
  assert.equal((await restoredAssistantSettings.getRuntimeConfig()).llmApiKey, 'synthetic-assistant-rehearsal-key');
  assert.equal((await restoredAssistantSettings.getRuntimeConfig()).assistantEnabled, false);
  assert.equal((await createAssistantSettings({ pool: dstPool }).getRuntimeConfig()).llmApiKey, '');
  assert.equal(
    (await dstPool.query('SELECT requests FROM assistant_usage WHERE user_id=$1', [bootstrap.user.id])).rows[0]
      .requests,
    2
  );
  await assert.rejects(
    createAssistantUsage({ pool: dstPool }).reserveRequest({
      userId: bootstrap.user.id,
      limit: 2
    }),
    (error) => error.status === 429
  );
  const restoredAuth = createHouseholdAuth({
    pool: dstPool,
    config: { mode: 'live' }
  });
  assert.equal((await restoredAuth.session(authRequest)).email, 'restore-admin@example.invalid');
  assert.equal((await restoredAuth.setupStatus()).setupRequired, false);
  assert.equal((await dstPool.query('SELECT token_hash FROM household_invitations')).rows[0].token_hash, inviteHash);
  assert.equal(
    (await dstPool.query('SELECT permission FROM user_account_grants WHERE user_id=$1', [memberId])).rows[0].permission,
    'view'
  );
  assert.equal(
    (await dstPool.query('SELECT permission FROM user_budget_grants WHERE user_id=$1', [memberId])).rows[0].permission,
    'edit'
  );

  const restoredSettings = createSettingsStore({
    pool: dstPool,
    appSecret: syntheticMasterKey
  });
  assert.equal((await restoredSettings.getProviderConfig()).llmApiKey, 'synthetic-backup-key');
  const restoredClassification = await restoredSettings.getProviderConfig();
  assert.equal(restoredClassification.llmEnabled, true);
  assert.equal(restoredClassification.llmAutoClassify, false);
  assert.equal(restoredClassification.llmAutoApply, false);
  assert.equal(restoredClassification.llmDailyRequestLimit, 7);
  assert.equal(restoredClassification.llmBatchSize, 3);
  const restoredSimplefin = createSimplefinIntegration({
    pool: dstPool,
    store,
    settings: restoredSettings,
    config: { mode: 'demo', appSecret: syntheticMasterKey },
    request: async () => {
      throw Error('Provider I/O forbidden in restore rehearsal');
    }
  });
  assert.deepEqual(
    await restoredSimplefin.snapshot(),
    beforeSimplefin,
    'SimpleFIN source identity, encrypted Access URL and paused settings survive'
  );
  assert(!JSON.stringify(await restoredSimplefin.status()).includes('synthetic-access-password'));
  await assert.rejects(dstPool.query('DELETE FROM simplefin_fetches'), /immutable/);
  const restoredRedbarkSettings = createRedbarkSettings({
    pool: dstPool,
    settings: restoredSettings,
    appSecret: syntheticMasterKey
  });
  assert.deepEqual(
    await restoredRedbarkSettings.getRuntimeConfig(),
    beforeRedbarkConfig,
    'Redbark credentials, signing-key account binding, version and backfill settings survive'
  );
  const restoredRedbarkPublic = await restoredRedbarkSettings.getPublic();
  assert.equal(restoredRedbarkPublic.source, 'database');
  assert.equal(restoredRedbarkPublic.credentials.apiKey.configured, true);
  assert.equal(restoredRedbarkPublic.signingSecretAssociated, true);
  assert.equal(restoredRedbarkPublic.backfillDays, 45);
  assert.equal(restoredRedbarkPublic.version, '2026-10-01.wattle');
  assert.ok(!JSON.stringify(restoredRedbarkPublic).includes('synthetic-redbark'));
  assert.ok(!JSON.stringify(restoredRedbarkPublic).includes('synthetic-signing-key'));
  assert.equal(await restoredSettings.getSecret('redbark.webhook.signingSecret', 'redbark'), 'synthetic-signing-key');
  for (const [setting, provider, value] of extraCredentials) {
    assert.equal(await restoredSettings.getSecret(setting, provider), value);
  }

  assert.equal(
    (await dstPool.query("SELECT count(*)::int count FROM notification_outbox WHERE status='pending'")).rows[0].count,
    1
  );
  assert.equal(
    (await dstPool.query("SELECT count(*)::int count FROM notification_outbox WHERE status='sent'")).rows[0].count,
    1
  );
  assert.equal((await restored.listAccounts()).find((a) => a.id === firstAccount.id).name, 'Fictional local label');
  const noKeySettings = createSettingsStore({ pool: dstPool });
  assert.equal((await noKeySettings.getProviderConfig()).llmCredentialsUnavailable, true);
  const noKeyRedbark = await createRedbarkSettings({
    pool: dstPool,
    settings: noKeySettings
  }).getRuntimeConfig();
  assert.equal(noKeyRedbark.redbarkApiKey, '');
  assert.equal(noKeyRedbark.redbarkWebhookSecret, '');
  assert.equal(noKeyRedbark.redbarkCredentialsUnavailable, true);
  assert.deepEqual(await snapshot(dstPool), before, 'Every restored table row must exactly match');
  assert.deepEqual(
    await Promise.all(months.map((month) => restored.report({ month, currency: 'AUD' }))),
    beforeReports,
    'Complete financial reports must match'
  );
  assert.equal((await restored.getTransaction(transaction.id)).note, 'Fictional backup rehearsal correction');
  assert.ok((await restored.audit(transaction.id)).length > 0);
  await assert.rejects(dstPool.query("UPDATE provider_observations SET payload='{}'"), /immutable/);
  const oldMax = (await dstPool.query('SELECT max(id)::text AS id FROM redbark_jobs')).rows[0].id;
  const nextId = (
    await dstPool.query("INSERT INTO redbark_jobs(dedupe_key) VALUES('fictional-after-restore') RETURNING id::text")
  ).rows[0].id;
  assert.ok(BigInt(nextId) > BigInt(oldMax), 'Sequences restored');
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        server: (await admin.query('SHOW server_version')).rows[0].server_version,
        source,
        target,
        counts: Object.fromEntries(Object.entries(before).map(([name, rows]) => [name, rows.length])),
        financialTotals: beforeReports.map((r, i) => ({
          month: months[i],
          currency: 'AUD',
          incomeMinor: r.incomeMinor,
          expensesMinor: r.expensesMinor,
          netMinor: r.netMinor,
          pendingMinor: r.pendingMinor
        })),
        checks: [
          'SimpleFIN encrypted Access URL, source ownership, claim replay hashes, queued retry windows and immutable raw evidence survive without network calls',
          'Independent encrypted assistant credentials and durable per-user quota restore without any provider request',
          'Database-backed Redbark API/signing keys, account binding, version and backfill settings restore without network calls',
          'Classification enablement and independent automatic-classification switch, apply consent, daily limit and batch size survive',
          'Household users, hashed sessions, hashed invitations, closed bootstrap and independent resource grants survive',
          'Every row in every public table matches exactly',
          'Complete financial reports including budgets/coverage match',
          'Manual correction and audit survive',
          'Immutable observation trigger survives',
          'Job sequence advances after restore',
          'Pending/sent notification outbox, durable transitions and registration state match',
          'Backfill job parameters/retry state and account local labels survive',
          'Synthetic SMTP and Telegram encrypted credentials restore without sending',
          'Encrypted provider and signing credentials restore with separately retained master key',
          'Missing master key fails credential access closed after restore'
        ]
      },
      null,
      2
    )
  );
} finally {
  for (const pool of pools) {
    await pool.end();
  }

  for (const name of created.reverse()) {
    await admin.query(`DROP DATABASE ${name}`);
  }

  await admin.end();
  await rm(backupDir, { recursive: true, force: true });
}
