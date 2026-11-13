import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ACCESS_TOKEN_LABEL_MAX, accessTokenCreateBodySchema } from "@kerdial/api-contracts";
import { ApiError } from "../lib/api-client.js";
import { ACCESS_TOKENS_COPY } from "../lib/copy/access-tokens.js";
import { messageForError } from "../lib/problem-messages.js";
import { ACCESS_TOKENS_QUERY_KEY, createAccessTokenMutationOptions } from "../lib/queries.js";
import { Banner, Button, Checkbox, Dialog, Input, Select, type SelectOption } from "./ui/index.js";

/** MCP-L2: the expiry choices, 90 days preselected; « Jamais » sends `null`. */
const NEVER = "never";
const DEFAULT_EXPIRY = "90";
const EXPIRY_OPTIONS: readonly SelectOption[] = [
  { value: "30", label: ACCESS_TOKENS_COPY.expiry30 },
  { value: "90", label: ACCESS_TOKENS_COPY.expiry90 },
  { value: "180", label: ACCESS_TOKENS_COPY.expiry180 },
  { value: "365", label: ACCESS_TOKENS_COPY.expiry365 },
  { value: NEVER, label: ACCESS_TOKENS_COPY.expiryNever },
];

const EXPIRY_DAYS: Readonly<Record<string, number | null>> = {
  "30": 30,
  "90": 90,
  "180": 180,
  "365": 365,
  [NEVER]: null,
};

type CopyState = "idle" | "copied" | "failed";

function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

export interface AccessTokenCreateDialogProps {
  /** Called once the dialog is dismissed; the parent unmounts it, dropping every piece of its state. */
  readonly onClose: () => void;
}

/**
 * « Nouveau jeton d'accès » (ADR-0019; MCP-FR-20, MCP-FR-22, MCP-L2, MCP-L11,
 * MCP-L17).
 *
 * Two views in one dialog: the form, then — on `201` — the secret, shown once.
 *
 * **The form.** Submit stays disabled until the label passes the shared
 * schema's own rule, the current password is non-empty and the
 * acknowledgement is ticked; the whole body is then parsed with
 * `accessTokenCreateBodySchema` before `mutate()`, so the dialog and the route
 * agree on what a valid request is. The acknowledgement is never sent
 * (MCP-L11): it gates the button, nothing more.
 *
 * **The two `401`s.** `CURRENT_PASSWORD_INCORRECT` is a typo: shown on the
 * password field, the dialog stays open. `UNAUTHENTICATED` means the session
 * ended while the request waited (a password change won the race): a banner
 * says so, and closing the dialog refetches the token list, whose `401` takes
 * the app's ordinary logged-out path (`main.tsx`'s query-cache handler). The
 * create mutation is exempt from that handler (`skipGlobal401`), so neither
 * case navigates away while the user is reading the dialog.
 *
 * **The secret.** It lives in the mutation's result and nowhere else: never
 * in a URL, storage or a persisted cache. Closing calls `mutation.reset()`
 * and the parent unmounts this component; `gcTime: 0` makes the
 * `MutationCache` drop the `201` body at once. « Copier » uses
 * `navigator.clipboard`, which a plain-HTTP origin does not have; on that
 * path (or a refused write) the field is selected and a note asks for a
 * manual copy.
 */
export function AccessTokenCreateDialog({ onClose }: AccessTokenCreateDialogProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation(createAccessTokenMutationOptions(queryClient));
  // A wrapper, because the kit's `Input` takes no ref.
  const secretFieldRef = useRef<HTMLDivElement>(null);

  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState(DEFAULT_EXPIRY);
  const [currentPassword, setCurrentPassword] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");

  const labelValid = accessTokenCreateBodySchema.shape.label.safeParse(label).success;
  const canSubmit = labelValid && currentPassword !== "" && acknowledged;

  const code = mutation.isError ? errorCode(mutation.error) : undefined;
  const passwordError =
    code === "CURRENT_PASSWORD_INCORRECT" ? messageForError(mutation.error).text : undefined;
  const sessionEnded = code === "UNAUTHENTICATED";

  function close(): void {
    mutation.reset();
    if (sessionEnded) {
      // The ordinary logged-out handling, now that the user has read why.
      void queryClient.invalidateQueries({ queryKey: ACCESS_TOKENS_QUERY_KEY });
    }
    onClose();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit || mutation.isPending) return;
    const parsed = accessTokenCreateBodySchema.safeParse({
      label,
      expiresInDays: EXPIRY_DAYS[expiry] ?? null,
      currentPassword,
    });
    if (!parsed.success) return;
    mutation.reset();
    mutation.mutate(parsed.data);
  }

  async function copySecret(secret: string): Promise<void> {
    try {
      // Undefined on an insecure (plain-HTTP, non-localhost) origin.
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("no clipboard");
      await navigator.clipboard.writeText(secret);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
      const field = secretFieldRef.current?.querySelector("input");
      field?.focus();
      field?.select();
    }
  }

  const created = mutation.data;

  return (
    <Dialog
      open
      onClose={close}
      title={
        created === undefined ? ACCESS_TOKENS_COPY.dialogTitle : ACCESS_TOKENS_COPY.secretTitle
      }
      closeLabel={ACCESS_TOKENS_COPY.close}
      testId="access-token-dialog"
      rawBody
    >
      {created === undefined ? (
        <form onSubmit={handleSubmit} noValidate>
          <div className="k-dialog-body flex flex-col gap-4">
            <Input
              label={ACCESS_TOKENS_COPY.labelLabel}
              hint={ACCESS_TOKENS_COPY.labelHint}
              data-testid="access-token-label"
              required
              maxLength={ACCESS_TOKEN_LABEL_MAX}
              autoComplete="off"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />

            <Select
              label={ACCESS_TOKENS_COPY.expiryLabel}
              options={EXPIRY_OPTIONS}
              data-testid="access-token-expiry"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
              {...(expiry === NEVER ? { hint: ACCESS_TOKENS_COPY.neverNote } : {})}
            />

            <Input
              label={ACCESS_TOKENS_COPY.currentPasswordLabel}
              data-testid="access-token-current-password"
              type="password"
              required
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              {...(passwordError !== undefined
                ? { error: passwordError }
                : { hint: ACCESS_TOKENS_COPY.currentPasswordHint })}
            />

            <p className="text-sm text-text-body">{ACCESS_TOKENS_COPY.scope}</p>
            <p className="text-sm text-text-body" data-testid="access-token-disclosure">
              {ACCESS_TOKENS_COPY.disclosure}
            </p>

            <Checkbox
              label={ACCESS_TOKENS_COPY.acknowledge}
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />

            {sessionEnded && (
              <Banner tone="loss" testId="access-token-create-error">
                {ACCESS_TOKENS_COPY.sessionEnded}
              </Banner>
            )}
            {mutation.isError && passwordError === undefined && !sessionEnded && (
              <Banner tone="loss" testId="access-token-create-error">
                {messageForError(mutation.error).text}
              </Banner>
            )}
          </div>
          <footer className="k-dialog-foot">
            <Button variant="ghost" data-testid="access-token-cancel" onClick={close}>
              {ACCESS_TOKENS_COPY.cancel}
            </Button>
            <Button
              type="submit"
              variant="primary"
              data-testid="access-token-submit"
              disabled={!canSubmit || sessionEnded}
              loading={mutation.isPending}
            >
              {ACCESS_TOKENS_COPY.submit}
            </Button>
          </footer>
        </form>
      ) : (
        <>
          <div className="k-dialog-body flex flex-col gap-4">
            <div ref={secretFieldRef} className="[&_input]:font-mono">
              <Input
                label={ACCESS_TOKENS_COPY.secretLabel}
                data-testid="access-token-secret"
                readOnly
                spellCheck={false}
                autoComplete="off"
                value={created.secret}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
            <Banner tone="warn" testId="access-token-secret-warning">
              {ACCESS_TOKENS_COPY.secretWarning}
            </Banner>
            {copyState === "failed" && (
              <p
                role="status"
                className="text-sm text-text-body"
                data-testid="access-token-copy-failed"
              >
                {ACCESS_TOKENS_COPY.copyFailed}
              </p>
            )}
          </div>
          <footer className="k-dialog-foot">
            <Button
              variant="secondary"
              data-testid="access-token-copy"
              onClick={() => void copySecret(created.secret)}
            >
              {copyState === "copied" ? ACCESS_TOKENS_COPY.copied : ACCESS_TOKENS_COPY.copy}
            </Button>
            <Button variant="primary" data-testid="access-token-close" onClick={close}>
              {ACCESS_TOKENS_COPY.close}
            </Button>
          </footer>
        </>
      )}
    </Dialog>
  );
}
