import { readTestPostgresConfig } from './helpers/postgres.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createHouseholdAuth, hashHouseholdPassword, verifyHouseholdPassword } from '../src/household-auth.js';
import { Store } from '../src/store.js';
import { ensureAccessSchema } from '../src/access.js';
import { createUserManagement } from '../src/users.js';
const database = readTestPostgresConfig();
test(
  'household invitations bind email/role, expire, revoke, resend, reset and protect administrators',
  { skip: !database },
  async () => {
    const admin = new pg.Pool(database),
      schema = `users_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    try {
      await new Store(pool, { mode: 'live' }).migrate();
      await ensureAccessSchema(pool);
      await createHouseholdAuth({ pool, config: {} }).init();
      const passwordHash = await hashHouseholdPassword('synthetic long password');
      const actorId = (
        await pool.query(
          "INSERT INTO household_users(email,name,role,password_hash) VALUES('admin@example.test','Admin','admin',$1) RETURNING id",
          [passwordHash]
        )
      ).rows[0].id;
      let now = Date.now(),
        mail = [],
        failMail = false;
      const settings = {
        getValue: async () => ({ from: 'dolphino@example.test' }),
        getSecret: async () => 'smtps://synthetic:synthetic@smtp.example.test:465'
      };
      const users = createUserManagement({
        pool,
        config: { origin: 'https://dolphino.example.test' },
        settings,
        now: () => now,
        sendMail: async (data) => {
          if (failMail) {
            throw Error('secret must not escape');
          }
          mail.push(data);
        }
      });
      await users.init();
      const tokenFromMail = () => mail.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
      await pool.query(
        "INSERT INTO accounts(id,mode,name,currency) VALUES('acct_test','live','Synthetic account','AUD')"
      );
      await assert.rejects(
        users.invite({
          actorId,
          email: 'invalidtarget@example.test',
          grants: {
            accounts: [{ accountId: 'missing', access: 'view' }],
            budgets: []
          }
        }),
        /Grant target not found/
      );
      let invited = await users.invite({
        actorId,
        email: ' Member@Example.Test ',
        role: 'member',
        grants: {
          accounts: [{ accountId: 'acct_test', access: 'view' }],
          budgets: []
        }
      });
      const oldToken = tokenFromMail();
      assert.equal(invited.deliveryState, 'sent');
      assert.equal(invited.email, 'member@example.test');
      assert.ok(!JSON.stringify(invited).includes(oldToken));
      assert.ok(!JSON.stringify((await pool.query('SELECT * FROM household_invitations')).rows).includes(oldToken));
      invited = await users.resend({ actorId, invitationId: invited.id });
      const token = tokenFromMail();
      assert.notEqual(token, oldToken);
      await assert.rejects(
        users.activate({
          token: oldToken,
          password: 'synthetic member password',
          name: 'Member'
        }),
        /invalid or expired/
      );
      const results = await Promise.allSettled([
        users.activate({
          token,
          password: 'synthetic member password',
          name: 'Member'
        }),
        users.activate({
          token,
          password: 'synthetic member password',
          name: 'Member'
        })
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const member = (await pool.query("SELECT * FROM household_users WHERE email='member@example.test'")).rows[0];
      assert.equal(member.role, 'member');
      assert.equal(
        (await pool.query('SELECT permission FROM user_account_grants WHERE user_id=$1', [member.id])).rows[0]
          .permission,
        'view'
      );
      const catalog = await users.grantOptions({ actorId });
      assert.equal(catalog.accounts[0].id, 'acct_test');
      assert.ok(await verifyHouseholdPassword('synthetic member password', member.password_hash));
      await assert.rejects(users.invite({ actorId: member.id, email: 'forged@example.test' }), /Administrator/);
      await assert.rejects(users.updateUser({ actorId, userId: actorId, role: 'member' }), /own administrator/);
      await assert.rejects(users.updateUser({ actorId, userId: actorId, disabled: true }), /own administrator/);
      await pool.query(
        "INSERT INTO household_sessions(token_hash,user_id,expires_at) VALUES('synthetic-session',$1,now()+interval '1 hour')",
        [member.id]
      );
      await users.updateUser({ actorId, userId: member.id, role: 'admin' });
      assert.equal(
        (await pool.query('SELECT * FROM user_account_grants WHERE user_id=$1', [member.id])).rowCount,
        0,
        'promotion clears stale grants'
      );
      assert.equal((await pool.query('SELECT * FROM household_sessions WHERE user_id=$1', [member.id])).rowCount, 0);
      await users.resetPassword({ actorId, userId: member.id });
      const resetToken = tokenFromMail();
      await pool.query(
        "INSERT INTO household_sessions(token_hash,user_id,expires_at) VALUES('synthetic-reset-session',$1,now()+interval '1 hour')",
        [member.id]
      );
      await users.activate({
        token: resetToken,
        password: 'synthetic changed password'
      });
      assert.equal((await pool.query('SELECT * FROM household_sessions WHERE user_id=$1', [member.id])).rowCount, 0);
      await assert.rejects(
        users.activate({
          token: resetToken,
          password: 'synthetic changed password'
        }),
        /invalid or expired/
      );
      let revoked = await users.invite({
        actorId,
        email: 'revoke@example.test',
        role: 'admin'
      });
      const revokedToken = tokenFromMail();
      await users.revoke({ actorId, invitationId: revoked.id });
      await assert.rejects(
        users.activate({
          token: revokedToken,
          password: 'synthetic another password',
          name: 'Revoke'
        }),
        /invalid or expired/
      );
      await users.invite({ actorId, email: 'expire@example.test' });
      const expired = tokenFromMail();
      now += 8 * 86400000;
      await assert.rejects(
        users.activate({
          token: expired,
          password: 'synthetic another password',
          name: 'Expire'
        }),
        /invalid or expired/
      );
      failMail = true;
      const failed = await users.invite({
        actorId,
        email: 'failure@example.test'
      });
      assert.equal(failed.deliveryState, 'failed');
      assert.ok(!failed.lastError.includes('secret'));
      failMail = false;
      assert.equal((await users.resend({ actorId, invitationId: failed.id })).deliveryState, 'sent');
      const link = await users.createRecoveryLink({
        email: 'admin@example.test'
      });
      assert.ok(link.startsWith('https://dolphino.example.test/reset-password#token='));
      await users.activate({
        token: link.split('#token=')[1],
        password: 'synthetic recovery password'
      });
      const list = await users.list({ actorId });
      assert.ok(!JSON.stringify(list).includes('password_hash'));
      assert.ok(!JSON.stringify(list).includes('token_hash'));
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);
