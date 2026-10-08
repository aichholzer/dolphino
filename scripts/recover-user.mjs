// Lets an administrator back in when every administrator is locked out or email is unavailable. It prints
// a one-hour, single-use password reset link for an existing active account.
//   node --env-file=.env scripts/recover-user.mjs --email you@example.com
//   docker compose exec app node scripts/recover-user.mjs --email you@example.com
//
// Anyone who can run this with the deployment's database settings can take over any account.
// Keep the checkout, .env and secrets/ readable only by the operator, never expose this through
// an HTTP route, and keep the printed link out of shared terminals, logs and chat.
import { ensureDeploymentMode } from '../backend/src/lib/deployment-mode.mjs';
import { createPool } from '../backend/src/lib/db.mjs';
import { readConfig } from '../backend/src/lib/config.mjs';
import { createUserManagement } from '../backend/src/lib/users.mjs';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--email') {
  console.error('Usage: node scripts/recover-user.mjs --email user@example.com');
  process.exitCode = 1;
} else {
  let pool;
  try {
    const config = readConfig();
    if (config.mode !== 'live') {
      throw Error('Recovery requires live mode');
    }

    pool = await createPool();
    await ensureDeploymentMode(pool, config.mode);
    const users = createUserManagement({ pool, config, settings: null });
    const link = await users.createRecoveryLink({ email: args[1] });
    console.log(
      'One-use password reset link, expires in one hour. Treat as a secret; do not paste into chat, logs, or tickets:'
    );
    console.log(link);
  } catch {
    console.error(
      'Recovery link could not be created. Check the email, live database, migrated schema and HTTPS application origin.'
    );
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
