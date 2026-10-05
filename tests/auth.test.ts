import { describe, expect, it } from "vitest";
import { checkApiKey } from "@/lib/api/http";
import { createSessionToken, isAuthorizedRequest, isValidSessionToken, passwordMatches } from "@/lib/auth/session";

describe("auth", () => {
  it("checks the admin password", () => {
    expect(passwordMatches(process.env.ADMIN_PASSWORD!)).toBe(true);
    expect(passwordMatches("wrong")).toBe(false);
  });

  it("signs and verifies session tokens", async () => {
    const token = await createSessionToken();
    expect(await isValidSessionToken(token)).toBe(true);
    expect(await isValidSessionToken(token + "x")).toBe(false);
    expect(await isValidSessionToken(undefined)).toBe(false);
  });

  it("accepts the cron secret or a session cookie", async () => {
    const cron = new Request("http://x/api/generator/tick", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    expect(await isAuthorizedRequest(cron)).toBe(true);
    const cookie = new Request("http://x", { headers: { cookie: `a=b; wo_session=${await createSessionToken()}` } });
    expect(await isAuthorizedRequest(cookie)).toBe(true);
    expect(await isAuthorizedRequest(new Request("http://x", { headers: { authorization: "Bearer nope" } }))).toBe(false);
  });

  it("requires the wallet API key", () => {
    expect(checkApiKey(new Request("http://x"))?.status).toBe(401);
    expect(checkApiKey(new Request("http://x", { headers: { "x-api-key": process.env.WALLET_API_KEY! } }))).toBeNull();
  });
});
