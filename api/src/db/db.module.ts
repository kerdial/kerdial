import { Module, type DynamicModule } from "@nestjs/common";
import type { Db } from "@kerdial/platform-db";
import { DB } from "./db.tokens.js";

/**
 * Makes the single `Db` handle `buildApp` was given available to every
 * feature module via `@Inject(DB)`, without any module needing to know how
 * it was constructed (a real `postgres.js` connection in production, a
 * Testcontainers-backed one in tests — see `app.ts`'s `BuildAppOptions`).
 * `global: true` so `AuthGuard`/`CsrfGuard` (registered as `APP_GUARD`s on
 * the root module) and every future feature module can inject it without
 * each one re-importing `DbModule`.
 */
@Module({})
export class DbModule {
  static forRoot(db: Db): DynamicModule {
    return {
      module: DbModule,
      global: true,
      providers: [{ provide: DB, useValue: db }],
      exports: [DB],
    };
  }
}
