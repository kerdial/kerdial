import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccessTokenResponse } from "../lib/api-client.js";
import { ACCESS_TOKENS_COPY } from "../lib/copy/access-tokens.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { messageForError } from "../lib/problem-messages.js";
import { accessTokensQueryOptions, revokeAccessTokenMutationOptions } from "../lib/queries.js";
import { AccessTokenCreateDialog } from "./AccessTokenCreateDialog.js";
import { Badge, Banner, Button, Card, Dialog, Icon, Skeleton, type BadgeTone } from "./ui/index.js";

/** MCP-L19: the public documentation of the MCP package, on the code repository's default branch. */
const DOC_URL = "https://github.com/kerdial/kerdial/blob/main/docs/mcp.md";

const STATUS_LABEL: Readonly<Record<AccessTokenResponse["status"], string>> = {
  active: ACCESS_TOKENS_COPY.statusActive,
  expired: ACCESS_TOKENS_COPY.statusExpired,
  revoked: ACCESS_TOKENS_COPY.statusRevoked,
};

const STATUS_TONE: Readonly<Record<AccessTokenResponse["status"], BadgeTone>> = {
  active: "brand",
  expired: "neutral",
  revoked: "neutral",
};

/** The date part of a server ISO-8601 UTC instant, in the app's French form — no client date arithmetic. */
function isoDay(instant: string): string {
  return formatIsoDateFr(instant.slice(0, 10));
}

/**
 * « Accès pour assistants IA » on « Mon compte » (ADR-0019; MCP-FR-19,
 * MCP-FR-21, MCP-L15, MCP-L19): the caller's own personal access tokens, a
 * create dialog and revocation.
 *
 * Quiet by default — no tone, no banner unless something failed. The empty
 * state says the feature is off until a token exists (MCP-FR-1). Every row
 * shows what the server says: `status` is computed there, dates are its
 * instants reformatted, and the label is rendered as text.
 *
 * Revocation goes through a confirmation dialog; « Annuler » closes it and
 * sends nothing. The create dialog is mounted only while open, so closing it
 * unmounts every piece of its state, the shown-once secret included.
 */
export function AccessTokensSettings() {
  const queryClient = useQueryClient();
  const query = useQuery(accessTokensQueryOptions());
  const revokeMutation = useMutation(revokeAccessTokenMutationOptions(queryClient));
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<AccessTokenResponse | null>(null);

  const items = query.data?.items;

  function closeRevoke(): void {
    revokeMutation.reset();
    setRevoking(null);
  }

  function confirmRevoke(): void {
    if (revoking === null) return;
    revokeMutation.mutate(revoking.id, { onSuccess: () => setRevoking(null) });
  }

  return (
    <Card>
      <section className="flex flex-col gap-4" data-testid="access-tokens-settings">
        <h2 className="text-base font-semibold text-text-strong">
          {ACCESS_TOKENS_COPY.sectionTitle}
        </h2>
        <p className="text-sm text-text-muted">
          {ACCESS_TOKENS_COPY.intro} {ACCESS_TOKENS_COPY.passwordNote}
        </p>
        <a
          href={DOC_URL}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="access-tokens-doc-link"
          className="inline-flex items-center gap-1 self-start text-sm font-medium text-text-brand underline"
        >
          {ACCESS_TOKENS_COPY.docLink}
          <Icon name="external-link" size="xs" />
        </a>

        {query.isError && items === undefined ? (
          <Banner tone="loss" testId="access-tokens-load-error">
            {messageForError(query.error).text}
          </Banner>
        ) : items === undefined ? (
          <Skeleton
            rows={2}
            size="compact"
            label={COMMON_COPY.loading}
            testId="access-tokens-loading"
          />
        ) : items.length === 0 ? (
          <p className="text-sm text-text-muted" data-testid="access-tokens-empty">
            {ACCESS_TOKENS_COPY.empty}
          </p>
        ) : (
          <ul
            className="flex flex-col divide-y divide-border-subtle"
            data-testid="access-tokens-list"
          >
            {items.map((token) => (
              <li
                key={token.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
                data-testid={`access-token-row-${token.id}`}
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="break-all text-sm font-medium text-text-strong">
                      {token.label}
                    </span>
                    <span className="k-mono text-xs text-text-muted">{token.hint}</span>
                  </span>
                  <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                    <div className="flex gap-1">
                      <dt>{ACCESS_TOKENS_COPY.colCreated}</dt>
                      <dd className="k-mono">{isoDay(token.createdAt)}</dd>
                    </div>
                    <div className="flex gap-1">
                      <dt>{ACCESS_TOKENS_COPY.colExpires}</dt>
                      {token.expiresAt === null ? (
                        <dd>{ACCESS_TOKENS_COPY.noExpiry}</dd>
                      ) : (
                        <dd className="k-mono">{isoDay(token.expiresAt)}</dd>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <dt>{ACCESS_TOKENS_COPY.colLastUsed}</dt>
                      {token.lastUsedAt === null ? (
                        <dd>{ACCESS_TOKENS_COPY.neverUsed}</dd>
                      ) : (
                        <dd className="k-mono">{isoDay(token.lastUsedAt)}</dd>
                      )}
                    </div>
                  </dl>
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge
                    tone={STATUS_TONE[token.status]}
                    data-testid={`access-token-status-${token.id}`}
                  >
                    {STATUS_LABEL[token.status]}
                  </Badge>
                  {token.status === "active" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={fill(ACCESS_TOKENS_COPY.revokeAria, { label: token.label })}
                      data-testid={`access-token-revoke-${token.id}`}
                      onClick={() => {
                        revokeMutation.reset();
                        setRevoking(token);
                      }}
                    >
                      {ACCESS_TOKENS_COPY.revoke}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        <Button
          variant="secondary"
          iconLeft="plus"
          data-testid="access-tokens-create"
          onClick={() => setCreating(true)}
        >
          {ACCESS_TOKENS_COPY.create}
        </Button>
      </section>

      {creating && <AccessTokenCreateDialog onClose={() => setCreating(false)} />}

      <Dialog
        open={revoking !== null}
        onClose={closeRevoke}
        title={ACCESS_TOKENS_COPY.revokeTitle}
        description={revoking?.label}
        closeLabel={ACCESS_TOKENS_COPY.close}
        width={468}
        testId="access-token-revoke-dialog"
        footer={
          <>
            <Button variant="ghost" data-testid="access-token-revoke-cancel" onClick={closeRevoke}>
              {ACCESS_TOKENS_COPY.cancel}
            </Button>
            <Button
              variant="danger"
              data-testid="access-token-revoke-confirm"
              loading={revokeMutation.isPending}
              onClick={confirmRevoke}
            >
              {ACCESS_TOKENS_COPY.revokeConfirm}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-body">{ACCESS_TOKENS_COPY.revokeBody}</p>
          {revokeMutation.isError && (
            <Banner tone="loss" testId="access-token-revoke-error">
              {messageForError(revokeMutation.error).text}
            </Banner>
          )}
        </div>
      </Dialog>
    </Card>
  );
}
