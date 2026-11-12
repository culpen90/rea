import { expect, it } from "vitest";
import { resolveAnalysisDocument } from "./AnalysisDocument.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "./AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { createEvidence, parseEvidence } from "../domain/evidence.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import { err, ok } from "../domain/result.js";

const provider = {
  id: "controlled",
  name: "Controlled document provider",
  version: "1",
};
it.each([
  null,
  "caller stopped",
  { request: "opaque" },
  new AnalysisCapabilityUnavailableError(
    "caller",
    "caller_operation",
    "Caller-owned cleanup",
    {
      cleanup: {
        reason: "caller resource not released",
        resources: ["caller resource"],
      },
    },
  ),
])("retains the exact admission cancellation reason: %j", async (reason) => {
  const controller = new AbortController();
  controller.abort(reason);
  const result = await resolveAnalysisDocument(
    {
      execute: async () => {
        throw new Error("must not query provider");
      },
    },
    undefined,
    controller.signal,
  );
  if (result.ok) throw new Error("expected cancelled admission");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(result.error.cleanupIncomplete).toBe(false);
  if (reason instanceof AnalysisCapabilityUnavailableError)
    expect(reason.cleanupIncomplete).toBe(true);
});

it.each([false, true])(
  "preserves unavailable selection with incomplete cleanup (cancelled: %s)",
  async (aborted) => {
    const controller = new AbortController();
    const failure = new AnalysisCapabilityUnavailableError(
      "controlled",
      "list_documents",
      "Unavailable while cleanup is pending",
      {
        cleanup: {
          reason: "live provider resource",
          resources: ["controlled resource"],
        },
      },
    );
    const calls: string[] = [];
    const port: AnalysisOperationPort = {
      execute: async (operation) => {
        calls.push(operation);
        if (aborted) controller.abort(null);
        return operation === "list_documents"
          ? err(failure)
          : ok(createAnalysisExecution(["selected"], provider));
      },
    };
    const result = await resolveAnalysisDocument(
      port,
      undefined,
      controller.signal,
    );
    expect(result).toEqual(err(failure));
    expect(calls).toEqual(["list_documents"]);
    expect(failure.cleanupIncomplete).toBe(true);
  },
);

it.each(["list_documents"] as const)(
  "retains validated %s observations and their profile on late cancellation",
  async (completedOperation) => {
    const controller = new AbortController();
    const reason = { request: "late selection" };
    const profile = createAnalysisProfile(provider, { fixture: true });
    const resultValue = ["selected"];
    const subject = {
      path: "/selected/image",
      sha256: "a".repeat(64),
      format: "pe",
    } as const;
    const locations = [{ kind: "artifact-path" as const, path: subject.path }];
    const rawResult = { selected_source: "controlled" };
    const limitations = ["controlled provider only"];
    const execution = createAnalysisExecution(resultValue, provider, {
      rawResult,
      limitations,
      analysisProfile: profile,
      relationshipCoverage: { status: "complete" },
      subject,
      locations,
    });
    const result = await resolveAnalysisDocument(
      {
        execute: async (operation) => {
          expect(operation).toBe(completedOperation);
          controller.abort(reason);
          return ok(execution);
        },
      },
      undefined,
      controller.signal,
    );
    if (result.ok) throw new Error("expected cancelled completion");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    const partial = parseEvidence(result.error.partialObservation);
    expect(partial).toMatchObject({
      operation: completedOperation,
      parameters: {},
      provider,
      confidence: "observed",
      normalized_result: ["selected"],
      raw_result: { selected_source: "controlled" },
      limitations: ["controlled provider only"],
      subject: { local_path: "/selected/image" },
      locations: [{ kind: "artifact-path", path: "/selected/image" }],
      analysis_profile: profile,
      relationship_coverage: { status: "complete" },
    });
    const control = createEvidence(subject, provider, {
      operation: completedOperation,
      parameters: {},
      result: resultValue,
      rawResult,
      limitations,
      confidence: "observed",
      analysisProfile: profile,
      relationshipCoverage: { status: "complete" },
      locations,
    });
    expect(partial.evidence_id).toBe(control.evidence_id);
  },
);

it("keeps analysis_profile null when a completed execution has no profile", async () => {
  const controller = new AbortController();
  const result = await resolveAnalysisDocument(
    {
      execute: async () => {
        controller.abort({ request: "late selection" });
        return ok(createAnalysisExecution(["selected"], provider));
      },
    },
    undefined,
    controller.signal,
  );
  if (result.ok) throw new Error("expected cancelled completion");
  expect(parseEvidence(result.error.partialObservation).analysis_profile).toBe(
    null,
  );
});

it.each(["list_documents"] as const)(
  "validates malformed %s before late cancellation",
  async (completedOperation) => {
    const controller = new AbortController();
    const result = await resolveAnalysisDocument(
      {
        execute: async (operation) => {
          expect(operation).toBe(completedOperation);
          controller.abort(null);
          return ok(createAnalysisExecution(null, provider));
        },
      },
      undefined,
      controller.signal,
    );
    if (result.ok) throw new Error("expected output refusal");
    expect(result.error).toBeInstanceOf(AnalysisOutputError);
    expect(result.error.partialObservation).toBeUndefined();
  },
);

it("preserves an explicit document without provider selection", async () => {
  await expect(
    resolveAnalysisDocument(
      {
        execute: async () => {
          throw new Error("must not query");
        },
      },
      "caller selection",
      undefined,
    ),
  ).resolves.toEqual(ok("caller selection"));
});
