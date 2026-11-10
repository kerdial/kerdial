import { createConnection } from "node:net";

/**
 * A guard for the one environmental precondition this suite cannot
 * detect from inside a test.
 *
 * `vite.config.ts` proxies `/api` to `http://localhost:3000`, so any API
 * process listening there answers every request no spec happens to mock.
 * Unauthenticated, those answers are `401`, and `src/main.tsx`'s global 401
 * handler turns any 401 into `queryClient.clear()` + a redirect to `/login` —
 * the screen under test disappears and every later assertion times out. The
 * failures land on whichever specs happen to issue an unmocked read, so they
 * scatter differently from run to run and read exactly like flake (one
 * measured series: 3/17/8/0/2). In CI nothing listens on :3000, so this can
 * only ever be a local divergence from what CI actually tests.
 *
 * Measured cost of not catching it (this repo, `main`, Desktop Chrome): a
 * clean run is 135 passed / 0 failed in ~61s; with a 401-answering process on
 * :3000 the same suite had not finished after **9 minutes** and was killed.
 * Nine minutes of red is a bad way to learn about a stray container, hence a
 * two-second check that names the cause.
 */
async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const settle = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1_000);
    socket.on("connect", () => settle(true));
    socket.on("timeout", () => settle(false));
    socket.on("error", () => settle(false));
  });
}

export default async function globalSetup(): Promise<void> {
  if (await isListening(3000)) {
    throw new Error(
      [
        "An API is listening on 127.0.0.1:3000, and this suite cannot run against it.",
        "",
        "vite.config.ts proxies /api there, so that process answers every request no",
        "spec mocks — 401 for anything unauthenticated — and the app's global 401",
        "handler then redirects away from the screen under test. The result is a large,",
        "scattered set of timeouts that looks like flake and is not.",
        "CI has nothing on :3000, so a run in this state is testing a different system",
        "than CI tests.",
        "",
        "  ss -ltnp | grep :3000            # find it",
        "  (cd deploy && docker compose stop)  # if it is the self-hosted stack",
      ].join("\n"),
    );
  }
}
