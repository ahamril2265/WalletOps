/**
 * Test database. Uses TEST_DATABASE_URL when it is set (CI provides a Postgres service);
 * otherwise starts a throwaway embedded PostgreSQL for the test run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

let stop: (() => Promise<void>) | undefined;

export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const dir = mkdtempSync(path.join(tmpdir(), "walletops-test-"));
    const port = 55_000 + Math.floor(Math.random() * 5_000);
    const server = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {} });
    await server.initialise();
    await server.start();
    const admin = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${port}/postgres` });
    await admin.connect();
    await admin.query("create database walletops_test encoding 'UTF8' template template0");
    await admin.end();
    url = `postgres://postgres:postgres@localhost:${port}/walletops_test`;
    stop = async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  await migrate(drizzle(pool), { migrationsFolder: path.resolve("drizzle") });
  await pool.end();

  project.provide("databaseUrl", url);
  return async () => {
    if (stop) await stop();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
