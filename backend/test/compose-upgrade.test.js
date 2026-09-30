import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, copyFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let hasCompose = false;
try {
  execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
  hasCompose = true;
} catch {
  // Parsing needs the official Docker Compose CLI, never a running daemon.
}

test(
  "Compose rename preserves explicitly selected PostgreSQL storage and refuses implicit bundled defaults",
  {
    skip: !hasCompose && "Docker Compose CLI is not installed",
    timeout: 20000,
  },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "dolphino-compose-security-"),
    );
    try {
      for (const name of ["compose.yaml", "compose.postgres.yaml"])
        await copyFile(
          new URL(`../../${name}`, import.meta.url),
          join(directory, name),
        );
      const external = {
        DATABASE_URL:
          "postgresql://existing_user:synthetic_only@existing-db.example.invalid:5432/existing_ledger",
        DATABASE_URL_FILE: "/run/secrets/existing_database_url",
      };
      const old = {
        POSTGRES_VOLUME: "old_custom_project_profe_postgres",
        POSTGRES_DB: "profe",
        POSTGRES_USER: "profe",
        POSTGRES_PASSWORD: "synthetic_only_not_a_real_password",
      };
      async function config(
        values,
        { bundled = true, project = "dolphino" } = {},
      ) {
        await writeFile(
          join(directory, ".env"),
          Object.entries(values)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n") + "\n",
          { mode: 0o600 },
        );
        const args = [
          "compose",
          "--project-directory",
          directory,
          "--project-name",
          project,
          "--env-file",
          join(directory, ".env"),
          "-f",
          join(directory, "compose.yaml"),
        ];
        if (bundled) args.push("-f", join(directory, "compose.postgres.yaml"));
        args.push("config", "--format", "json");
        return JSON.parse(
          execFileSync("docker", args, {
            cwd: directory,
            env: { PATH: process.env.PATH },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
      }
      const lane = await config(external, { bundled: false });
      assert.deepEqual(Object.keys(lane.services), ["app"]);
      assert.equal(
        lane.services.app.environment.DATABASE_URL,
        external.DATABASE_URL,
      );
      assert.equal(
        lane.services.app.environment.DATABASE_URL_FILE,
        external.DATABASE_URL_FILE,
      );
      assert.equal(lane.volumes, undefined);
      for (const missing of Object.keys(old)) {
        const values = { ...external, ...old };
        delete values[missing];
        await assert.rejects(
          config(values),
          (error) => error.status !== 0 && error.stderr.includes(missing),
          missing,
        );
      }
      const before = await config(
        { ...external, ...old },
        { project: "profe" },
      );
      const after = await config(
        { ...external, ...old },
        { project: "dolphino" },
      );
      for (const deployment of [before, after]) {
        assert.deepEqual(deployment.volumes.postgres_data, {
          name: old.POSTGRES_VOLUME,
          external: true,
        });
        assert.equal(deployment.services.db.volumes[0].source, "postgres_data");
        assert.equal(
          deployment.services.db.volumes[0].target,
          "/var/lib/postgresql/data",
        );
        assert.equal(deployment.services.db.environment.POSTGRES_DB, "profe");
        assert.equal(deployment.services.db.environment.POSTGRES_USER, "profe");
        assert.equal(
          deployment.services.db.environment.POSTGRES_PASSWORD,
          old.POSTGRES_PASSWORD,
        );
        assert.equal(
          deployment.services.app.environment.DATABASE_URL,
          `postgresql://profe:${old.POSTGRES_PASSWORD}@db:5432/profe`,
        );
        assert.equal(deployment.services.app.environment.DATABASE_URL_FILE, "");
        assert.equal(deployment.services.db.ports, undefined);
        assert.equal(deployment.services.db.image, "postgres:17-alpine");
      }
      const fresh = await config({
        ...external,
        ...old,
        POSTGRES_VOLUME: "dolphino_postgres",
        POSTGRES_DB: "dolphino",
        POSTGRES_USER: "dolphino",
      });
      assert.equal(fresh.volumes.postgres_data.name, "dolphino_postgres");
      assert.equal(fresh.volumes.postgres_data.external, true);
      assert.match(
        fresh.services.app.environment.DATABASE_URL,
        /^postgresql:\/\/dolphino:.*@db:5432\/dolphino$/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
