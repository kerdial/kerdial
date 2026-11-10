import "reflect-metadata";
import { Controller, Get, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { ExecutionContext } from "@nestjs/common";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@kerdial/platform-db";
import { DbModule } from "../db/db.module.js";
import { AuthGuard } from "./auth.guard.js";
import { CsrfGuard } from "./csrf.guard.js";
import { CsrfSecretModule } from "./csrf-secret.module.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import type { RequestWithSession } from "./session-request.js";

/**
 * Security review finding L1: `@Public()` is typed `MethodDecorator` only
 * (not `MethodDecorator & ClassDecorator`), and both guards read the
 * `isPublic` metadata only from `context.getHandler()`, never
 * `context.getClass()`. This proves the runtime half of that: even a caller
 * that bypasses TypeScript's decorator-position check entirely — by calling
 * the decorator function directly on a class constructor, which is exactly
 * what `@Public() class Foo {}` itself compiles down to — gets no exemption.
 * No cookie is sent, so `AuthGuard` never reaches `validateSession` (it
 * short-circuits to a `null` session before touching the DB at all) — the
 * fixture's `db` never needs to be real, so this runs with no
 * Testcontainers/Postgres dependency.
 */
@Controller("fixture-class-level-public")
class ClassLevelPublicFixtureController {
  @Get("route")
  route(): { ok: true } {
    return { ok: true };
  }
}

// Exactly what Nest's `SetMetadata` (which `Public()` is built on) does when
// applied as a class decorator — `@Public() class Foo {}` compiles to
// precisely this `Reflect.defineMetadata` call on the constructor. Written
// directly here (rather than `@Public()` itself, whose `MethodDecorator`
// typing now makes that call a compile error — the type-level half of this
// fix) to prove the *runtime* behaviour still holds even if someone bypassed
// the type system entirely (e.g. plain JS, or a cast).
Reflect.defineMetadata(IS_PUBLIC_KEY, true, ClassLevelPublicFixtureController);

@Module({
  imports: [DbModule.forRoot({} as unknown as Db), CsrfSecretModule.forRoot("fixture-csrf-secret")],
  controllers: [ClassLevelPublicFixtureController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
class FixtureModule {}

describe("@Public() cannot be exempted at the class level (security review L1)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(FixtureModule, new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("a route on a class carrying (runtime-forced) class-level @Public() metadata still returns 401 with no session", async () => {
    const response = await supertest(app.getHttpServer()).get("/fixture-class-level-public/route");
    expect(response.status).toBe(401);
  });
});

/**
 * `CsrfGuard`'s own half of L1, tested directly against a fabricated
 * `ExecutionContext` (no full Nest bootstrap) — this is the realistic shape
 * of the invariant `CsrfGuard` actually depends on: by the time it runs in
 * the real app, `AuthGuard` has already resolved and attached a session
 * (guard order, `app.module.ts`), so the meaningful question for L1 here is
 * "does class-level `@Public()` metadata exempt the header check even when a
 * session IS present" — not "what happens with no session at all" (that
 * case is `AuthGuard`'s own 401, proven above, and never reaches this code
 * path in the real app).
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

describe("CsrfGuard: class-level @Public() does not exempt a state-changing route (security review L1)", () => {
  const secret = "test-csrf-secret";
  const guard = new CsrfGuard(new Reflector(), secret);

  it("a POST with a resolved session but no CSRF header is rejected (403), despite class-level @Public() metadata", () => {
    class FixtureController {}
    // Exactly what `@Public()` compiles to when (mis)applied at the class
    // level — see the doc comment above `ClassLevelPublicFixtureController`.
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, FixtureController);
    function handler(): void {
      /* no per-handler metadata */
    }

    const request: Partial<RequestWithSession> = {
      method: "POST",
      headers: {},
      session: {
        tenantId: "tenant-1",
        userId: "user-1",
        sessionId: "session-1",
        isInstanceAdmin: false,
      },
    };
    const context = fakeExecutionContext({
      handler,
      controllerClass: FixtureController,
      request,
    });

    expect(() => guard.canActivate(context)).toThrow();
  });
});
