import { inject } from "vitest";

process.env.DATABASE_URL = inject("databaseUrl");
process.env.DB_POOL_MAX ??= "12";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters";
process.env.ADMIN_PASSWORD ??= "test-password";
process.env.WALLET_API_KEY ??= "test-key";
process.env.CRON_SECRET ??= "test-cron";
