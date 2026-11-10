/** One route as Fastify's router actually registered it (post global-prefix). */
export interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
}

/**
 * Collects every route Fastify registers, via the `onRoute` lifecycle hook —
 * `buildApp` wires this in before `app.init()` triggers Nest's controller
 * registration. This is what backs the AC32 cross-endpoint 401 sweep: it
 * enumerates the app's *actual* registered routes from the framework itself
 * (dynamically), rather than a hand-maintained list that would silently stop
 * covering a route added by a later task (T-37/T-38/T-39).
 */
export class RouteRegistry {
  private readonly _routes: RegisteredRoute[] = [];

  add(method: string, path: string): void {
    this._routes.push({ method: method.toUpperCase(), path });
  }

  get routes(): readonly RegisteredRoute[] {
    return this._routes;
  }
}
