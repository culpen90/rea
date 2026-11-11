import { expect, it, vi } from "vitest";
import { createDeferred } from "../../tests/fixtures/binarySession.js";

import { inspectAddressContext } from "./AnalysisContextQueries.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
  type AnalysisExecution,
} from "./AnalysisProvider.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  primaryAnalysisError,
  type AnalysisError,
} from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";
import { err, ok } from "../domain/result.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };

it.each([
  [null, "expected a list of document identities"],
  [[], "expected exactly one document identity"],
  [["fixture", "another"], "expected exactly one document identity"],
] as const)(
  "rejects invalid or ambiguous provider document selection (%j)",
  async (documents, message) => {
    const execute = vi.fn(async () =>
      ok(
        createAnalysisExecution(
          documents === null ? null : [...documents],
          provider,
        ),
      ),
    );
    const result = await inspectAddressContext(
      { execute },
      { address: "0x401000" },
    );
    if (result.ok) throw new Error("expected invalid document selection");
    expect(result.error).toBeInstanceOf(AnalysisOutputError);
    expect(result.error.message).toContain(message);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "list_documents",
      {},
      undefined,
    );
  },
);

it("propagates facet cancellation as a request failure", async () => {
  const cancelled = new AnalysisCancelledError("address_name");
  const analysis: AnalysisOperationPort = {
    execute: async (operation) =>
      operation === "address_name"
        ? err(cancelled)
        : ok(createAnalysisExecution(null, provider)),
  };

  await expect(
    inspectAddressContext(analysis, {
      address: "0x401000",
      document: "fixture",
    }),
  ).resolves.toEqual(err(cancelled));
});

it("does not start address facets after document selection completes under cancellation", async () => {
  const controller = new AbortController();
  const reason = { request: "cancelled after document selection" };
  const calls: string[] = [];
  const result = await inspectAddressContext(
    {
      execute: async (operation) => {
        calls.push(operation);
        controller.abort(reason);
        return ok(createAnalysisExecution(["fixture"], provider));
      },
    },
    { address: "0x401000" },
    controller.signal,
  );
  if (result.ok) throw new Error("expected cancelled selection");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(calls).toEqual(["list_documents"]);
});

it("retains both facet cleanup owners until their independent retries succeed", async () => {
  const first = new AnalysisCapabilityUnavailableError(
    provider.id,
    "resolve_containing_procedure",
    "failed",
    {
      cleanup: { reason: "first release failed", resources: ["first-owner"] },
    },
  );
  const second = new AnalysisCapabilityUnavailableError(
    provider.id,
    "address_name",
    "failed",
    {
      cleanup: { reason: "second release failed", resources: ["second-owner"] },
    },
  );
  let firstRetryAllowed = false;
  const firstLease = new AnalysisCleanupLease(async () => {
    if (!firstRetryAllowed) throw new Error("still owned");
  }, ["first-owner"]);
  const secondLease = new AnalysisCleanupLease(async () => {}, [
    "second-owner",
  ]);
  firstLease.bindCleanupError(first);
  secondLease.bindCleanupError(second);
  const result = await inspectAddressContext(
    {
      execute: async (operation) =>
        operation === "resolve_containing_procedure"
          ? err(first)
          : operation === "address_name"
            ? err(second)
            : ok(createAnalysisExecution(null, provider)),
    },
    { address: "0x401000", document: "fixture" },
  );
  if (result.ok) throw new Error("expected retained cleanup failures");
  expect(projectAnalysisError(result.error).code).toBe("cleanup_incomplete");
  expect(result.error.cleanupResources).toEqual(
    expect.arrayContaining(["first-owner", "second-owner"]),
  );
  await expect(firstLease.release()).rejects.toThrow("still owned");
  expect(result.error.cleanupResources).toEqual(
    expect.arrayContaining(["first-owner", "second-owner"]),
  );
  await secondLease.release();
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual(["first-owner"]);
  firstRetryAllowed = true;
  await firstLease.release();
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(result.error.cleanupResources).toEqual([]);
  expect(projectAnalysisError(result.error).code).toBe(
    "capability_unavailable",
  );
});

it("waits for late facet cleanup after cancellation and retains its owner", async () => {
  const controller = new AbortController();
  const started = createDeferred<void>();
  const late = createDeferred<Result<AnalysisExecution, AnalysisError>>();
  const failure = new AnalysisCapabilityUnavailableError(
    provider.id,
    "resolve_containing_procedure",
    "failed",
    {
      cleanup: { reason: "late cleanup failed", resources: ["late-owner"] },
    },
  );
  const lease = new AnalysisCleanupLease(async () => {}, ["late-owner"]);
  lease.bindCleanupError(failure);
  const analysis: AnalysisOperationPort = {
    execute: (operation) => {
      if (operation === "resolve_containing_procedure") {
        started.resolve();
        return late.promise;
      }
      return Promise.resolve(ok(createAnalysisExecution(null, provider)));
    },
  };
  let settled = false;
  const pending = inspectAddressContext(
    analysis,
    { address: "0x401000", document: "fixture" },
    controller.signal,
  ).then((result) => {
    settled = true;
    return result;
  });
  await started.promise;
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  late.resolve(err(failure));
  const result = await pending;
  if (result.ok) throw new Error("expected cancellation with cleanup failure");
  expect(projectAnalysisError(result.error).code).toBe("cleanup_incomplete");
  expect(result.error.cleanupResources).toEqual(["late-owner"]);
  await lease.release();
  expect(projectAnalysisError(result.error).code).toBe("cancelled");
});

it("reports cancellation after a late successful facet that ignored its signal", async () => {
  const controller = new AbortController();
  const started = createDeferred<void>();
  const late = createDeferred<Result<AnalysisExecution, AnalysisError>>();
  const pending = inspectAddressContext(
    {
      execute: (operation) => {
        if (operation === "resolve_containing_procedure") {
          started.resolve();
          return late.promise;
        }
        return Promise.resolve(ok(createAnalysisExecution(null, provider)));
      },
    },
    { address: "0x401000", document: "fixture" },
    controller.signal,
  );
  await started.promise;
  controller.abort();
  late.resolve(ok(createAnalysisExecution("finished", provider)));
  const result = await pending;
  if (result.ok) throw new Error("expected cancellation");
  expect(projectAnalysisError(result.error).code).toBe("cancelled");
});

it("does not start facets for an already-cancelled explicit document", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls: string[] = [];
  const result = await inspectAddressContext(
    {
      execute: async (operation) => {
        calls.push(operation);
        return ok(createAnalysisExecution(null, provider));
      },
    },
    { address: "0x401000", document: "fixture" },
    controller.signal,
  );
  if (result.ok) throw new Error("expected cancellation");
  expect(projectAnalysisError(result.error).code).toBe("cancelled");
  expect(calls).toEqual([]);
});

it("preserves a provider's cancellation for the same signal", async () => {
  const controller = new AbortController();
  const started = createDeferred<void>();
  const reason = { request: "controlled cancellation" };
  let providerCancellation: AnalysisCancelledError | undefined;
  const pending = inspectAddressContext(
    {
      execute: (operation) => {
        if (operation !== "address_name")
          return Promise.resolve(ok(createAnalysisExecution(null, provider)));
        started.resolve();
        return new Promise((resolve) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              providerCancellation = new AnalysisCancelledError(operation, {
                cause: controller.signal.reason,
                diagnostics: { owner: "controlled provider" },
              });
              resolve(err(providerCancellation));
            },
            { once: true },
          );
        });
      },
    },
    { address: "0x401000", document: "fixture" },
    controller.signal,
  );
  await started.promise;
  controller.abort(reason);
  const result = await pending;
  if (result.ok) throw new Error("expected cancellation");
  expect(result.error).toBe(providerCancellation);
  expect(projectAnalysisError(result.error).details).toMatchObject({
    diagnostics: { owner: "controlled provider" },
  });
});

it.each([false, true])(
  "keeps an earlier cleanup failure primary when cancellation arrives later (cancellation cleanup=%s)",
  async (cancelCleanup) => {
    const controller = new AbortController();
    const firstDone = createDeferred<void>();
    const failure = new AnalysisCapabilityUnavailableError(
      provider.id,
      "resolve_containing_procedure",
      "failed",
      {
        cleanup: { reason: "cleanup failed", resources: ["first-owner"] },
      },
    );
    const lease = new AnalysisCleanupLease(async () => {}, ["first-owner"]);
    lease.bindCleanupError(failure);
    const cancelled = new AnalysisCancelledError(
      "address_name",
      cancelCleanup
        ? {
            cleanup: {
              reason: "cancel cleanup failed",
              resources: ["cancel-owner"],
            },
          }
        : undefined,
    );
    const cancellationLease = new AnalysisCleanupLease(async () => {}, [
      "cancel-owner",
    ]);
    if (cancelCleanup) cancellationLease.bindCleanupError(cancelled);
    const analysis: AnalysisOperationPort = {
      execute: async (operation) => {
        if (operation === "address_name")
          return new Promise((resolve) => {
            controller.signal.addEventListener(
              "abort",
              () => resolve(err(cancelled)),
              { once: true },
            );
          });
        if (operation === "resolve_containing_procedure") {
          firstDone.resolve();
          return err(failure);
        }
        return ok(createAnalysisExecution(null, provider));
      },
    };
    const pending = inspectAddressContext(
      analysis,
      { address: "0x401000", document: "fixture" },
      controller.signal,
    );
    await firstDone.promise;
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    if (result.ok) throw new Error("expected retained cleanup failure");
    expect(primaryAnalysisError(result.error)).toBe(failure);
    expect(failure.secondaryFailures).toContain(cancelled);
    expect(projectAnalysisError(result.error).code).toBe("cleanup_incomplete");
    await lease.release();
    if (cancelCleanup) {
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources).toEqual(["cancel-owner"]);
      await cancellationLease.release();
    }
    expect(projectAnalysisError(result.error).code).toBe(
      "capability_unavailable",
    );
  },
);
