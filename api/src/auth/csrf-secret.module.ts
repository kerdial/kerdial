import { Module, type DynamicModule } from "@nestjs/common";
import { CSRF_SECRET } from "./csrf-token.js";

/**
 * Makes the CSRF HMAC secret (security review finding L2, `csrf-token.ts`)
 * available to every module that needs it (`AuthController` to issue a
 * token at login, `CsrfGuard` to recompute one to verify against) via
 * `@Inject(CSRF_SECRET)`, the same shape `DbModule` uses for `DB`.
 */
@Module({})
export class CsrfSecretModule {
  static forRoot(secret: string): DynamicModule {
    return {
      module: CsrfSecretModule,
      global: true,
      providers: [{ provide: CSRF_SECRET, useValue: secret }],
      exports: [CSRF_SECRET],
    };
  }
}
