// Local development database: a real PostgreSQL 17 running from node_modules (no Docker needed).
// Data is kept in ./.localdb between runs. Stop it with Ctrl+C.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, ".localdb");
const port = Number(process.env.LOCAL_DB_PORT ?? 54329);

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres",
  port,
  persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
});

if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
  console.log("Creating a new local database in .localdb ...");
  await server.initialise();
}
await server.start();

const admin = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${port}/postgres` });
await admin.connect();
const exists = await admin.query("select 1 from pg_database where datname = 'walletops'");
if (!exists.rowCount) await admin.query("create database walletops encoding 'UTF8' template template0");
await admin.end();

console.log(`\nPostgres is running.\n\n  DATABASE_URL=postgres://postgres:postgres@localhost:${port}/walletops\n`);
console.log("Put that line in .env.local, run `npm run db:migrate`, then `npm run dev` in another terminal.");
console.log("Press Ctrl+C to stop.\n");

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
