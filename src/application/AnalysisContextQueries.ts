import type {
  AnalysisExecution,
  AnalysisOperation,
  AnalysisOperationPort,
} from "./AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import {
  omitUnretainedEvidenceFromError,
  projectAnalysisError,
  unretainedEvidenceCandidates,
  type AnalysisErrorProjection,
} from "../domain/analysisErrorProjection.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { parseContainingProcedureResolution } from "../domain/native/nativeObservation.js";
import { resolveAnalysisDocument } from "./AnalysisDocument.js";
import { estimateJsonStorage } from "./JsonAuthenticationHeadroom.js";
import { err, ok, type Result } from "../domain/result.js";

type Facet =
  | { readonly state: "available"; readonly value: JsonValue }
  | {
      readonly state: "unavailable";
      readonly reason: string;
      readonly remediation: string;
      readonly error?: AnalysisErrorProjection;
    };

type AddressContext = {
  readonly address: string;
  readonly document: string;
  readonly name: Facet;
  readonly procedure: Facet;
};

/** Facets inspected after an explicit or provider-resolved document is known. */
export const ADDRESS_CONTEXT_FACET_OPERATIONS = [
  "address_name",
  "resolve_containing_procedure",
] as const satisfies readonly AnalysisOperation[];

const parameters = (
  document: string | undefined,
  address?: string,
): Readonly<Record<string, JsonValue>> => ({
  ...(document === undefined ? {} : { document }),
  ...(address === undefined ? {} : { address }),
});

const executionOptions = (
  signal: AbortSignal | undefined,
): { readonly signal?: AbortSignal } =>
  signal === undefined ? {} : { signal };

/** Preserve other facets and smaller partials if unretained Evidence cannot fit. */
export function* omitContextEvidenceForDelivery(
  context: AddressContext,
  limit: {
    readonly constraint: "receive-buffer" | "string-length";
    readonly bytesAtLeast: number;
  },
  budgetBytes: number,
): Generator<AddressContext> {
  const names = ["name", "procedure"] as const;
  const candidates = names.flatMap((name) => {
    const facet = context[name];
    if (facet.state !== "unavailable" || facet.error === undefined) return [];
    return [...unretainedEvidenceCandidates(facet.error)].map((candidate) => {
      const size = estimateJsonStorage(candidate.value, {
        maximumValueBytes: budgetBytes,
        includeSerialized: false,
      }).valueBytes;
      return { name, candidate, size };
    });
  });
  candidates.sort((left, right) => right.size - left.size);
  let current = context;
  for (const { name, candidate } of candidates) {
    const facet = current[name];
    if (facet.state !== "unavailable" || facet.error === undefined) continue;
    const compact = omitUnretainedEvidenceFromError(
      facet.error,
      limit,
      candidate,
    );
    if (compact === undefined) continue;
    current = {
      ...current,
      [name]: {
        ...facet,
        remediation: compact.remediation.action,
        error: compact,
      },
    };
    yield current;
  }
}

/** Inspect bounded provider-neutral facets at one explicit reproducible address. */
export const inspectAddressContext = async (
  analysis: AnalysisOperationPort,
  input: { readonly address: string; readonly document?: string | undefined },
  signal?: AbortSignal,
): Promise<Result<AddressContext, AnalysisError>> => {
  const document = await resolveAnalysisDocument(
    analysis,
    input.document,
    signal,
  );
  if (!document.ok) return document;
  const args = parameters(document.value, input.address);
  const operations = ADDRESS_CONTEXT_FACET_OPERATIONS;
  const completed: Result<AnalysisExecution, AnalysisError>[] = [];
  if (signal?.aborted === true)
    return err(
      new AnalysisCancelledError("inspect_address_context", {
        cause: signal.reason,
      }),
    );
  let signalCancellation: AnalysisCancelledError | undefined;
  const cancelled = () => {
    signalCancellation = new AnalysisCancelledError("inspect_address_context", {
      cause: signal?.reason,
    });
    completed.push(err(signalCancellation));
  };
  signal?.addEventListener("abort", cancelled, { once: true });
  let results: Result<AnalysisExecution, AnalysisError>[];
  try {
    results = await Promise.all(
      operations.map(async (operation) => {
        const result = await analysis.execute(
          operation,
          args,
          executionOptions(signal),
        );
        completed.push(result);
        return result;
      }),
    );
  } finally {
    signal?.removeEventListener("abort", cancelled);
  }
  const fatal = contextFailure(completed, signalCancellation);
  if (fatal !== undefined) return err(fatal);
  const name = facet(results[0], operations[0]);
  const procedureResult = results[1];
  const resolution = procedureResult?.ok
    ? parseContainingProcedureResolution(procedureResult.value.result)
    : procedureResult;
  const procedure: Facet = resolution?.ok
    ? { state: "available", value: resolution.value }
    : unavailableFacet(resolution?.error, operations[1]);
  return ok({
    address: input.address,
    document: document.value,
    name,
    procedure,
  });
};

const facet = (
  result: Result<AnalysisExecution, AnalysisError> | undefined,
  operation: AnalysisOperation,
): Facet =>
  result?.ok === true
    ? { state: "available", value: result.value.result }
    : unavailableFacet(result?.error, operation);

const unavailableFacet = (
  error: AnalysisError | undefined,
  operation: AnalysisOperation,
): Facet => {
  if (error instanceof AnalysisCapabilityUnavailableError) {
    const projected = projectAnalysisError(error);
    return {
      state: "unavailable",
      reason: error.userMessage ?? error.message,
      remediation:
        error.retryable ||
        error.remediationAction !== undefined ||
        error.fallbackRemediationAction !== undefined ||
        error.continuingCallerGuidance?.remediationAction !== undefined
          ? projected.remediation.action
          : "Review provider availability in binary_session with detail complete. If a name is known and search_procedures is available, use it to find candidates and verify their identity and coordinates.",
    };
  }
  if (
    error instanceof AnalysisInputError ||
    error instanceof AnalysisResourceConstraintError ||
    (error instanceof EvidenceIntegrityError &&
      error.sourcePublicationRecovery !== undefined)
  ) {
    const projected = projectAnalysisError(error);
    if (
      projected.code === "invalid_request" ||
      projected.code === "resource_constraint" ||
      projected.code === "evidence_integrity_mismatch"
    )
      return {
        state: "unavailable",
        reason: projected.message,
        remediation: projected.remediation.action,
        error: projected,
      };
  }
  return {
    state: "unavailable",
    reason: error?.message ?? `${operation} returned no result`,
    remediation: `Call ${operation} directly to inspect provider availability and diagnostics.`,
  };
};

const isRequestLevelFailure = (error: AnalysisError): boolean =>
  error._tag === "AnalysisCancelledError" ||
  error._tag === "AnalysisTimeoutError" ||
  error._tag === "NoBinaryOpenError" ||
  (error.sourcePublicationRecovery !== undefined &&
    !(error instanceof AnalysisInputError) &&
    !(error instanceof AnalysisResourceConstraintError) &&
    !(error instanceof EvidenceIntegrityError));

/** Wait for all facets and retain every unresolved cleanup owner. */
const contextFailure = (
  results: readonly Result<AnalysisExecution, AnalysisError>[],
  signalCancellation?: AnalysisCancelledError,
): AnalysisError | undefined => {
  const failures = [
    ...new Set(results.flatMap((result) => (result.ok ? [] : [result.error]))),
  ];
  // A provider's cancellation for this exact signal carries its own diagnostic
  // and cleanup facts. Attribute that returned error to the abort event rather
  // than replacing it with our generic observation of the same signal.
  const marker =
    signalCancellation === undefined
      ? -1
      : failures.indexOf(signalCancellation);
  if (marker >= 0) {
    const reported = failures.findIndex(
      (failure, index) =>
        index > marker &&
        failure instanceof AnalysisCancelledError &&
        failure.cause === signalCancellation?.cause,
    );
    if (reported >= 0) {
      failures[marker] = failures[reported]!;
      failures.splice(reported, 1);
    }
  }
  const first = failures.find(
    (failure) => isRequestLevelFailure(failure) || failure.cleanupIncomplete,
  );
  if (first === undefined) return undefined;
  let combined = first;
  for (const failure of failures) {
    if (failure === first) continue;
    if (failure instanceof AnalysisCancelledError)
      combined = analysisErrorWithCancellation(combined, failure);
    if (failure.cleanupIncomplete) {
      const previous = combined;
      combined = analysisErrorWithCleanupFailure(
        previous,
        failure,
        "inspect_address_context",
      ).bindCleanupDependencies([previous, failure]);
    } else if (
      !(failure instanceof AnalysisCancelledError) &&
      (isRequestLevelFailure(failure) ||
        failure.sourcePublicationRecovery !== undefined)
    ) {
      combined.retainSecondaryFailure(failure);
    }
  }
  return combined;
};
