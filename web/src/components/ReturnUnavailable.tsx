import { COMMON_COPY } from "../lib/copy/common.js";
import { PERFORMANCE_COPY } from "../lib/copy/performance.js";
import { DefinitionHint } from "./ui/GlossaryHint.js";

/**
 * Owner decision (option 1, superseding AC135's "rendered
 * verbatim"). An unavailable TWR or MWR reads as one French line chosen by the
 * wire's `reasonCode`; the API's English `reason` stays one tap away in the
 * hint. A code this build does not know, or a server too old to send one,
 * reads « Indisponible » — never the raw English as the figure.
 */
const LABEL_BY_CODE: Readonly<Record<string, string>> = {
  ZERO_INVESTED_BASE: PERFORMANCE_COPY.unavailableZeroBase,
  INSUFFICIENT_DATA: PERFORMANCE_COPY.unavailableInsufficientData,
  NO_ROOT_IN_BRACKET: PERFORMANCE_COPY.unavailableNoRoot,
  DID_NOT_CONVERGE: PERFORMANCE_COPY.unavailableNotConverged,
  NO_PORTFOLIO: PERFORMANCE_COPY.unavailableNoPortfolio,
};

export function returnUnavailableLabel(reasonCode: string | undefined): string {
  return (
    (reasonCode === undefined ? undefined : LABEL_BY_CODE[reasonCode]) ?? COMMON_COPY.unavailable
  );
}

export function ReturnUnavailable({
  reasonCode,
  reason,
  testId,
}: {
  readonly reasonCode?: string | undefined;
  readonly reason?: string | undefined;
  readonly testId?: string;
}) {
  return (
    <>
      {returnUnavailableLabel(reasonCode)}
      {reason !== undefined && reason !== "" ? (
        <>
          {" "}
          <DefinitionHint definition={reason} {...(testId === undefined ? {} : { testId })} />
        </>
      ) : null}
    </>
  );
}
