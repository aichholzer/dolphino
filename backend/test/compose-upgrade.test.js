import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let hasCompose = false;
try {
  execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
  hasCompose = true;
} catch {
  // Parsing needs the official Docker Compose CLI, never a running daemon.
}

test(
  'Compose preserves PG identity/storage, explicit TLS and APP_BIND without URL interpolation',
  { skip: !hasCompose && 'Docker Compose CLI is not installed', timeout: 20000 },
  async () => {
    for (const name of ['.gitignore', '.dockerignore']) {
      const ignored = await readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
      assert.match(ignored, /^postgres-secrets\/?$/m, `${name} must exclude bundled database password files`);
    }
    const directory = await mkdtemp(join(tmpdir(), 'dolphino-compose-security-'));
    try {
      for (const name of ['compose.yaml', 'compose.postgres.yaml', 'compose.postgres-ca.yaml']) {
        await copyFile(new URL(`../../${name}`, import.meta.url), join(directory, name));
      }
      const external = {
        PGHOST: 'existing-db.example.invalid',
        PGPORT: '5444',
        PGDATABASE: 'existing_ledger',
        PGUSER: 'existing_user',
        PGPASSWORD: 'synthetic:@/#?% password',
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: 'system',
        TRUST_PROXY: '192.0.2.2,2001:db8::1/128'
      };
      const old = { POSTGRES_VOLUME: 'old_custom_project_profe_postgres', PGDATABASE: 'profe', PGUSER: 'profe' };
      async function config(values, { bundled = true, project = 'dolphino', customCa = false } = {}) {
        await writeFile(
          join(directory, '.env'),
          Object.entries(values)
            .map(([key, value]) => `${key}='${value}'`)
            .join('\n') + '\n',
          { mode: 0o600 }
        );
        const args = [
          'compose',
          '--project-directory',
          directory,
          '--project-name',
          project,
          '--env-file',
          join(directory, '.env'),
          '-f',
          join(directory, 'compose.yaml')
        ];
        if (bundled) {
          args.push('-f', join(directory, 'compose.postgres.yaml'));
        }
        if (customCa) {
          args.push('-f', join(directory, 'compose.postgres-ca.yaml'));
        }
        args.push('config', '--format', 'json');
        return JSON.parse(
          execFileSync('docker', args, {
            cwd: directory,
            env: { PATH: process.env.PATH },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
          })
        );
      }
      const lane = await config(external, { bundled: false });
      assert.deepEqual(Object.keys(lane.services), ['app']);
      for (const [key, value] of Object.entries(external)) {
        assert.equal(lane.services.app.environment[key], value);
      }
      assert.equal(lane.services.app.environment.DATABASE_URL, undefined);
      assert.equal(lane.services.app.environment.DATABASE_URL_FILE, undefined);
      assert.equal(lane.services.app.ports[0].host_ip, '127.0.0.1');
      const lan = await config({ ...external, APP_BIND: '192.0.2.10' }, { bundled: false });
      assert.equal(lan.services.app.ports[0].host_ip, '192.0.2.10');
      assert.equal(lane.volumes, undefined);
      for (const missing of Object.keys(old)) {
        const values = { ...external, ...old };
        delete values[missing];
        await assert.rejects(config(values), (error) => error.status !== 0 && error.stderr.includes(missing), missing);
      }
      const bundled = { ...external, ...old, PGSSLMODE: '', PGSSLROOTCERT: '' };
      const before = await config(bundled, { project: 'profe' });
      const after = await config(bundled, { project: 'dolphino' });
      for (const deployment of [before, after]) {
        assert.deepEqual(deployment.volumes.postgres_data, { name: old.POSTGRES_VOLUME, external: true });
        assert.equal(deployment.services.db.volumes.find((v) => v.type === 'volume').source, 'postgres_data');
        assert.equal(
          deployment.services.db.volumes.find((v) => v.type === 'volume').target,
          '/var/lib/postgresql/data'
        );
        assert.equal(deployment.services.db.environment.POSTGRES_DB, 'profe');
        assert.equal(deployment.services.db.environment.POSTGRES_USER, 'profe');
        assert.equal(deployment.services.db.environment.POSTGRES_PASSWORD, external.PGPASSWORD);
        assert.equal(deployment.services.app.environment.PGHOST, 'db');
        assert.equal(deployment.services.app.environment.PGPORT, '5432');
        assert.equal(deployment.services.app.environment.PGDATABASE, 'profe');
        assert.equal(deployment.services.app.environment.PGUSER, 'profe');
        assert.equal(deployment.services.app.environment.PGPASSWORD, external.PGPASSWORD);
        assert.equal(deployment.services.app.environment.PGSSLMODE, 'disable');
        assert.equal(deployment.services.app.environment.PGSSLROOTCERT, '');
        assert.equal(deployment.services.db.ports, undefined);
        assert.equal(deployment.services.db.image, 'postgres:17-alpine');
      }
      const explicitTls = await config({ ...external, ...old });
      assert.equal(explicitTls.services.app.environment.PGSSLMODE, 'verify-full');
      assert.equal(explicitTls.services.app.environment.PGSSLROOTCERT, 'system');
      const passwordFile = '/run/postgres-secrets/password';
      const fileBased = await config({ ...bundled, PGPASSWORD: '', PGPASSWORD_FILE: passwordFile });
      assert.equal(fileBased.services.app.environment.PGPASSWORD, '');
      assert.equal(fileBased.services.app.environment.PGPASSWORD_FILE, passwordFile);
      assert.equal(fileBased.services.db.environment.POSTGRES_PASSWORD, '');
      assert.equal(fileBased.services.db.environment.POSTGRES_PASSWORD_FILE, passwordFile);
      assert(fileBased.services.db.volumes.some((v) => v.target === '/run/postgres-secrets' && v.read_only));
      assert(!fileBased.services.db.volumes.some((v) => v.target === '/run/secrets'));
      assert(fileBased.services.app.volumes.some((v) => v.target === '/run/postgres-secrets' && v.read_only));
      const fresh = await config({
        ...bundled,
        POSTGRES_VOLUME: 'dolphino_postgres',
        PGDATABASE: 'dolphino',
        PGUSER: 'dolphino'
      });
      assert.equal(fresh.volumes.postgres_data.name, 'dolphino_postgres');
      assert.equal(fresh.volumes.postgres_data.external, true);
      assert.equal(fresh.services.app.environment.PGDATABASE, 'dolphino');
      const rootPath = join(directory, 'synthetic-ca.pem');
      await writeFile(rootPath, 'synthetic config parsing fixture only');
      const custom = await config({ ...external, PGSSLROOTCERT: rootPath }, { bundled: false, customCa: true });
      assert.equal(custom.services.app.environment.PGSSLROOTCERT, '/run/postgres-ca/root.crt');
      const mount = custom.services.app.volumes.find((v) => v.target === '/run/postgres-ca/root.crt');
      assert.equal(mount.source, rootPath);
      assert.equal(mount.read_only, true);
      assert.notEqual(mount.bind?.create_host_path, true);
      await assert.rejects(
        config({ ...external, PGSSLROOTCERT: '' }, { bundled: false, customCa: true }),
        /PGSSLROOTCERT/
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);
