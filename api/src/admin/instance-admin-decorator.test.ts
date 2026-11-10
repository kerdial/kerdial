import "reflect-metadata";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { RequestWithSession } from "../auth/session-request.js";
import { InstanceAdminGuard } from "./instance-admin.guard.js";
import { IS_INSTANCE_ADMIN_KEY } from "./instance-admin.decorator.js";

/**
 * T-91 — `@InstanceAdmin()`'s own half of security review finding L1, the
 * property `auth/public-decorator.test.ts` already proves for `@Public()`:
 * the decorator is typed `MethodDecorator` only (a compile error at class
 * level), **and** `InstanceAdminGuard` reads the metadata from
 * `context.getHandler()` only, so class-level metadata forced on at runtime
 * is a no-op.
 *
 * The failure direction is the opposite of `@Public()`'s and worth naming:
 * a class-level `@Public()` that silently worked would *unguard* a
 * controller, while a class-level `@InstanceAdmin()` that silently did
 * nothing would leave routes ungated at the HTTP layer. Neither is
 * acceptable, and the same two mechanisms answer both. (The database's own
 * `42501` re-check is what actually keeps a non-admin out either way —
 * LD-4, proven at the DB layer by T-81 and at both layers by AC-382.)
 *
 * Tested against a fabricated `ExecutionContext` rather than a full Nest
 * bootstrap, matching `public-decorator.test.ts`'s own `CsrfGuard` half: in
 * the real app `AuthGuard` has already attached a session by the time this
 * guard runs, so the meaningful question is what it does with one present,
 * not what happens with no session at all (that case is `AuthGuard`'s 401,
 * swept for every route by `auth.e2e.test.ts`'s AC32).
 */
function fakeExecutionContext(params: {
  readonly handler: object;
  readonly controllerClass: object;
  readonly request: Partial<RequestWithSession>;
}): ExecutionContext {
  return {
    getHandler: () => params.handler,
    getClass: () => params.controllerClass,
    switchToHttp: () => ({ getRequest: () => params.request }),
  } as unknown as ExecutionContext;
}

function sessionFor(isInstanceAdmin: boolean): Partial<RequestWithSession> {
  return {
    method: "POST",
    headers: {},
    session: {
      tenantId: "tenant-1",
      userId: "user-1",
      sessionId: "session-1",
      isInstanceAdmin,
    },
  };
}

describe("InstanceAdminGuard", () => {
  const guard = new InstanceAdminGuard(new Reflector());

  it("lets an undecorated handler through regardless of the caller's flag (absent metadata means no requirement)", () => {
    function handler(): void {
      /* no per-handler metadata */
    }
    class FixtureController {}

    expect(
      guard.canActivate(
        fakeExecutionContext({
          handler,
          controllerClass: FixtureController,
          request: sessionFor(false),
        }),
      ),
    ).toBe(true);
  });

  it("lets an instance admin through a decorated handler", () => {
    function handler(): void {
      /* decorated below */
    }
    Reflect.defineMetadata(IS_INSTANCE_ADMIN_KEY, true, handler);
    class FixtureController {}

    expect(
      guard.canActivate(
        fakeExecutionContext({
          handler,
          controllerClass: FixtureController,
          request: sessionFor(true),
        }),
      ),
    ).toBe(true);
  });

  it("refuses a non-admin on a decorated handler with 403 NOT_INSTANCE_ADMIN", () => {
    function handler(): void {
      /* decorated below */
    }
    Reflect.defineMetadata(IS_INSTANCE_ADMIN_KEY, true, handler);
    class FixtureController {}

    let thrown: unknown;
    try {
      guard.canActivate(
        fakeExecutionContext({
          handler,
          controllerClass: FixtureController,
          request: sessionFor(false),
        }),
      );
    } catch (error) {
      thrown = error;
    }

    const response = (
      thrown as { getResponse: () => { status: number; code: string } }
    ).getResponse();
    expect((thrown as { getStatus: () => number }).getStatus()).toBe(403);
    expect(response.code).toBe("NOT_INSTANCE_ADMIN");
  });

  it("refuses when no session is attached at all (fail-closed, though AuthGuard makes this unreachable)", () => {
    function handler(): void {
      /* decorated below */
    }
    Reflect.defineMetadata(IS_INSTANCE_ADMIN_KEY, true, handler);
    class FixtureController {}

    expect(() =>
      guard.canActivate(
        fakeExecutionContext({
          handler,
          controllerClass: FixtureController,
          request: { method: "POST", headers: {} },
        }),
      ),
    ).toThrow();
  });

  it("class-level (runtime-forced) @InstanceAdmin() metadata is a no-op — the guard never reads getClass()", () => {
    function handler(): void {
      /* deliberately NOT decorated */
    }
    class FixtureController {}
    // Exactly what `@InstanceAdmin() class Foo {}` compiles down to — written
    // directly because the decorator's `MethodDecorator` typing makes that
    // call a compile error, which is the type-level half of L1. This proves
    // the runtime half: the metadata is simply not looked at.
    Reflect.defineMetadata(IS_INSTANCE_ADMIN_KEY, true, FixtureController);

    expect(
      guard.canActivate(
        fakeExecutionContext({
          handler,
          controllerClass: FixtureController,
          request: sessionFor(false),
        }),
      ),
    ).toBe(true);
  });
});
