// Trigger one generator tick on a running WalletOps (local or deployed).
//   node scripts/tick.mjs                       -> http://localhost:3000
//   APP_URL=https://your-app.vercel.app node scripts/tick.mjs
// Uses CRON_SECRET from the environment or .env.local.
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

const url = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "") + "/api/generator/tick";
const response = await fetch(url, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
});
console.log(response.status, JSON.stringify(await response.json(), null, 2));
