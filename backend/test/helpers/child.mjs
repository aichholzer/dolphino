import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { testPostgresEnv } from './postgres.mjs';

export const root = fileURLToPath(new URL('../../..', import.meta.url));

// Entry points read their whole configuration from the environment. Children get the test
// database, pinned to one schema, and nothing else from the parent's deployment settings.
export function childEnv(schema, overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(PG|DOLPHINO_|APP_|NEW_APP_|TEST_DATABASE_URL$|PORT$|HOST$|TRUST_PROXY$)/.test(key)) {
      env[key] = value;
    }
  }

  return { ...env, ...testPostgresEnv(), PGOPTIONS: `-c search_path=${schema}`, ...overrides };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
      .once('error', reject)
      .listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
  });
}

// Runs a Node entry point; `ready` resolves when stdout matches, `exited` when the process ends.
export function run(script, args, env, { ready: pattern } = {}) {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, ...output }));
  });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output.stdout += chunk;
      if (pattern?.test(output.stdout)) {
        resolve(output);
      }
    });
    child.stderr.on('data', (chunk) => {
      output.stderr += chunk;
    });
    exited.then((result) => reject(Object.assign(Error(`${script} exited before it was ready`), result)));
  });
  ready.catch(() => {});
  return { child, ready, exited, output };
}
