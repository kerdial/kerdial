import { SetMetadata } from "@nestjs/common";

/**
 * Opts one GET handler into the personal-access-token path — ADR-0019,
 * MCP-L6. A token reaches a handler only if it carries this decorator; every
 * other route answers `403 TOKEN_ROUTE_NOT_ALLOWED` (`TokenAccessGuard`), so
 * a new GET route is closed to tokens until someone writes this line beside
 * its `@Get(...)` and adds the route to the reachable-set list in
 * `token-auth.e2e.test.ts`.
 *
 * The `@Public()` / `@InstanceAdmin()` discipline: typed `MethodDecorator`
 * only, so class-level use is a compile error, and read by the guard from
 * `context.getHandler()` only, so class-level metadata forced at runtime is a
 * no-op. It grants nothing on its own — `TokenAccessGuard` refuses every
 * method but GET/HEAD before it looks at this flag.
 */
export const IS_TOKEN_READABLE_KEY = "isTokenReadable";
export const TokenReadable = (): MethodDecorator => SetMetadata(IS_TOKEN_READABLE_KEY, true);
