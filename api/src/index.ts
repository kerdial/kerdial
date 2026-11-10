export { buildApp, type BuildAppOptions, type BuiltApp } from "./app.js";
export type { RegisteredRoute } from "./route-registry.js";
// SH-26's single derivation of `API_BIND` — consumed by `tools/deploy-tests`'s
// compose gate, so `deploy/docker-compose.yml` is checked against the value
// the api actually binds, never a restated copy.
