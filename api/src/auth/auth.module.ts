import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { COOKIE_SECURE, resolveCookieSecure } from "./cookie-secure.js";
import { SETUP_TOKEN, SetupTokenAnnouncer, resolveSetupToken } from "./setup-token.js";

/**
 * `/auth/*`. `AuthGuard`/`CsrfGuard` are registered
 * globally in `app.module.ts` (`APP_GUARD`), not here — they apply to every
 * controller in the app, not only this one. `GET /auth/me`'s shared
 * cheap-read cap (MEDIUM-2) was retired (ADR-0016) for the instance-wide
 * admission bound registered in `app.module.ts`; the two public writes keep
 * their own caps as pre-constructed instances
 * (`publicWritePerClientThrottleInterceptor` and
 * `publicWriteInstanceThrottleInterceptor`).
 *
 * `SETUP_TOKEN` is provided **here**, not in `app.module.ts`:
 * `POST /auth/setup` is the only consumer, and a `useFactory` resolved once
 * per application means the value a test's app holds is the value that
 * application's boot line printed. `SetupTokenAnnouncer` is an ordinary
 * provider of this module so Nest calls its `onApplicationBootstrap` —
 * nothing else references it, which is why it is listed and not injected
 * anywhere.
 *
 * `COOKIE_SECURE` follows the same shape for the same reason: the
 * controller is the only place cookies are minted or cleared, and a factory
 * resolved once per application is what lets a test boot an app with the
 * flag off and assert the `Set-Cookie` it actually emits.
 */
@Module({
  controllers: [AuthController],
  providers: [
    { provide: SETUP_TOKEN, useFactory: () => resolveSetupToken() },
    { provide: COOKIE_SECURE, useFactory: () => resolveCookieSecure() },
    SetupTokenAnnouncer,
  ],
})
export class AuthModule {}
