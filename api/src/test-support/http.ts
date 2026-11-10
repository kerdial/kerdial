import type supertest from "supertest";
import { CSRF_COOKIE_NAME, SID_COOKIE_NAME } from "../auth/cookies.js";

/**
 * Cookie plumbing shared by `api`'s Supertest e2e suites — one
 * implementation instead of the per-file copy every suite
 * used to paste. Reads a value out of a raw `Set-Cookie` header array the
 * way the suites always have: first `name=` match, value up to the first
 * attribute separator.
 */
export function rawCookieValue(
  setCookie: readonly string[] | undefined,
  name: string,
): string | undefined {
  const raw = setCookie?.find((cookie) => cookie.startsWith(`${name}=`));
  return raw?.split(";")[0]?.slice(name.length + 1);
}

/** {@link rawCookieValue}, but a missing cookie fails loudly instead of flowing on as `undefined` behind a `!`. */
export function requireCookieValue(setCookie: readonly string[] | undefined, name: string): string {
  const value = rawCookieValue(setCookie, name);
  if (value === undefined) {
    throw new Error(`requireCookieValue: cookie ${name} not found in Set-Cookie response`);
  }
  return value;
}

/** What a successful `POST /auth/login` sets: the session cookie and its CSRF double-submit twin (`auth.controller.ts` sets both unconditionally on success). */
export interface SessionCookies {
  readonly sid: string;
  readonly csrf: string;
}

/**
 * The login half of every e2e suite's session setup: `POST /auth/login`,
 * then pull both cookies. Fails loudly on a non-200 or a missing cookie —
 * the pass conditions are the same as the per-file copies this replaces
 * (which either `expect(login.status).toBe(200)` or let a missing cookie
 * surface later behind a `!`), only the failure message is better. Suites
 * that seed their own user first keep their per-file register wrapper and
 * call this for the login half.
 */
export async function loginAs(
  server: ReturnType<typeof supertest>,
  email: string,
  password: string,
): Promise<SessionCookies> {
  const response = await server.post("/api/v1/auth/login").send({ email, password });
  if (response.status !== 200) {
    throw new Error(
      `loginAs(${email}): expected 200, got ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  const setCookie = response.headers["set-cookie"] as string[] | undefined;
  return {
    sid: requireCookieValue(setCookie, SID_COOKIE_NAME),
    csrf: requireCookieValue(setCookie, CSRF_COOKIE_NAME),
  };
}
