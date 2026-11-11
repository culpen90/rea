import type {
  AnalysisExecution,
  AnalysisOperationPort,
} from "./AnalysisProvider.js";
import { createAnalysisExecutionEvidence } from "../domain/analysisObservation.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { parseDocuments } from "../domain/native/nativeDocument.js";
import { err, ok, type Result } from "../domain/result.js";

const executionOptions = (signal: AbortSignal | undefined) =>
  signal === undefined ? undefined : { signal };

/** Resolve an explicit or provider-selected document without guessing among candidates. */
export const resolveAnalysisDocument = async (
  analysis: AnalysisOperationPort,
  document: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Result<string, AnalysisError>> => {
  if (document !== undefined) return ok(document);
  if (signal?.aborted === true)
    return err(
      new AnalysisCancelledError("list_documents", { cause: signal.reason }),
    );
  const listed = await analysis.execute(
    "list_documents",
    {},
    executionOptions(signal),
  );
  if (!listed.ok) return listed;
  const parsed = parseDocuments(listed.value.result);
  if (!parsed.ok)
    return err(
      new AnalysisOutputError(
        "list_documents",
        "expected a list of document identities",
        { cause: parsed.error },
      ),
    );
  if (parsed.value.length !== 1)
    return err(
      new AnalysisOutputError(
        "list_documents",
        `expected exactly one document identity for the active target, received ${parsed.value.length}`,
      ),
    );
  const [documentName] = parsed.value;
  if (documentName === undefined || documentName.length === 0)
    return err(
      new AnalysisOutputError(
        "list_documents",
        "provider returned no document identity",
      ),
    );
  return completeSelection(documentName, listed.value, signal);
};

/** Preserve the completed provider observation after validating document identity. */
const completeSelection = (
  document: string,
  execution: AnalysisExecution,
  signal: AbortSignal | undefined,
): Result<string, AnalysisError> => {
  if (signal?.aborted)
    return err(
      new AnalysisCancelledError("list_documents", {
        cause: signal.reason,
        partialObservation: createAnalysisExecutionEvidence(
          "list_documents",
          {},
          execution,
          "observed",
        ),
      }),
    );
  return ok(document);
};
