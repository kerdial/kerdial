import { SetMetadata } from "@nestjs/common";

/**
 * Marks a single route handler as reachable with no session — the
 * deliberately narrow opt-out from the global `AuthGuard` (`/auth/login` is the only route that should ever need this: there
 * is no session to check before one has been issued). `CsrfGuard` also
 * honours this: a request with no session has no CSRF cookie to
 * double-submit either.
 *
 * Security review finding L1: this is deliberately typed `MethodDecorator`
 * ONLY, not `MethodDecorator & ClassDecorator`. Both guards additionally
 * read this metadata only from `context.getHandler()` (never
 * `context.getClass()`) — see `auth.guard.ts`/`csrf.guard.ts`. Together,
 * these two facts make "apply `@Public()` to an entire controller class"
 * both a compile-time type error AND, even if bypassed at runtime (e.g. via
 * `@ts-expect-error` or plain JS), a no-op: there is no code path in either
 * guard that would ever look at class-level metadata for this key. A future
 * controller (T-37/T-38/T-39) therefore cannot silently exempt every one of
 * its routes from the AuthGuard/CsrfGuard by decorating the class.
 */
export const IS_PUBLIC_KEY = "isPublic";
export const Public = (): MethodDecorator => SetMetadata(IS_PUBLIC_KEY, true);
