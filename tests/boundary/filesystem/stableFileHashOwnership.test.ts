import { createHash } from "node:crypto";
import { open as openFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import * as regularFile from "../../../src/filesystem/RegularFile.js";
import { RegularFileAdmissionFailure } from "../../../src/filesystem/RegularFile.js";
import {
  hashStableFile,
  observeStableFile,
} from "../../../src/filesystem/StableFileHash.js";
import {
  RegularFileCancelled,
  RegularFileCleanupFailure,
} from "../../../src/filesystem/OwnedRegularFile.js";

it("rejects a real extent change after admission instead of replacing its baseline", async () => {
  const root = await createTestTempDirectory("rea-stable-admitted-extent-");
  const path = join(root, "input.bin");
  const original = Buffer.from("admitted extent");
  await writeFile(path, original);
  const nativeOpen = regularFile.openRegularFile;
  let descriptor: regularFile.StableRegularFileDescriptor | undefined;
  const open = vi
    .spyOn(regularFile, "openRegularFile")
    .mockImplementationOnce(async (...args) => {
      descriptor = await nativeOpen(...args);
      await writeFile(path, "a different and longer extent after admission");
      return descriptor;
    });
  try {
    const failure: unknown = await hashStableFile(path, {
      retainFailedClose: () => {
        throw new Error("Changed input descriptor must close successfully");
      },
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ _tag: "StableFileHashFailure" });
    if (!(failure instanceof Error)) throw new Error("Expected changed input");
    expect(failure.cause).toBeInstanceOf(regularFile.RegularFileChangedError);
    expect(descriptor?.initial.size).toBe(original.length);
    expect(descriptor?.handle.fd).toBe(-1);
  } finally {
    open.mockRestore();
    if (descriptor !== undefined && descriptor.handle.fd >= 0)
      await descriptor.handle.close();
  }
});

it("classifies a selected name removed at final validation as a changed file and closes its descriptor", async () => {
  const root = await createTestTempDirectory("rea-stable-name-removed-");
  const path = join(root, "input.bin");
  await writeFile(path, "admitted bytes");
  const nativeOpen = regularFile.openRegularFile;
  let descriptor: regularFile.StableRegularFileDescriptor | undefined;
  const open = vi
    .spyOn(regularFile, "openRegularFile")
    .mockImplementationOnce(async (...args) => {
      descriptor = await nativeOpen(...args);
      const nativeRead = descriptor.handle.read.bind(descriptor.handle);
      vi.spyOn(descriptor.handle, "read").mockImplementation(
        async (...args) => {
          const result = await nativeRead(...args);
          if (result.bytesRead === 0) await unlink(path);
          return result;
        },
      );
      return descriptor;
    });
  try {
    const retainFailedClose = vi.fn();
    const failure: unknown = await hashStableFile(path, {
      retainFailedClose,
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      _tag: "StableFileHashFailure",
      cause: {
        name: "RegularFileChangedError",
        code: "ESTALE",
        cause: { code: "ENOENT" },
      },
    });
    expect(descriptor?.handle.fd).toBe(-1);
    expect(retainFailedClose).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
    if (descriptor !== undefined && descriptor.handle.fd >= 0)
      await descriptor.handle.close();
  }
});

it("captures a two-byte prefix across short reads and buffer reuse", async () => {
  const root = await createTestTempDirectory("rea-stable-observation-prefix-");
  const path = join(root, "script");
  const bytes = Buffer.from("#!rest-of-file");
  await writeFile(path, bytes);
  const retained: OwnedFileHandle[] = [];
  const originalOpen = regularFile.openRegularFile;
  const open = vi
    .spyOn(regularFile, "openRegularFile")
    .mockImplementation(async (...args) => {
      const descriptor = await originalOpen(...args);
      const { handle } = descriptor;
      const positional: {
        read(
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ): Promise<{ bytesRead: number; buffer: Buffer }>;
      } = handle;
      const nativeRead = positional.read.bind(handle);
      vi.spyOn(positional, "read").mockImplementation(
        (buffer, offset, length, position) =>
          nativeRead(
            buffer,
            offset,
            position === 0 ? Math.min(length, 1) : length,
            position,
          ),
      );
      return descriptor;
    });
  try {
    const observation = await observeStableFile(path, {
      retainFailedClose: (owner) => retained.push(owner),
    });
    expect(observation).toMatchObject({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      prefix: Buffer.from("#!"),
    });
  } finally {
    open.mockRestore();
    for (const owner of retained) if (owner.handle.fd >= 0) await owner.close();
  }
});

it("adopts and retries the descriptor when hashing succeeded but close failed", async () => {
  const root = await createTestTempDirectory("rea-stable-hash-close-");
  const path = join(root, "input.bin");
  await writeFile(path, "owned bytes");
  const closeCause = new Error("injected descriptor close failure");
  const originalClose = OwnedFileHandle.prototype.close;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async () => {
      throw closeCause;
    });
  const retained: OwnedFileHandle[] = [];
  try {
    let failure: unknown;
    try {
      await hashStableFile(path, {
        retainFailedClose: (owner) => retained.push(owner),
      });
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    expect(retained).toHaveLength(1);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected a typed hash cleanup failure");
    expect(failure.outcome).toMatchObject({
      kind: "completed",
      value: { bytes: 11 },
    });
    expect(failure.cleanupCause).toBe(closeCause);
    expect(failure.retention).toEqual({ kind: "callback_returned" });
    expect(failure.owner).toBe(retained[0]);
    expect(retained[0]!.handle.fd).toBeGreaterThanOrEqual(0);
    close.mockRestore();
    await retained[0]!.close();
    expect(retained[0]!.handle.fd).toBe(-1);
  } finally {
    close.mockRestore();
    if (retained[0] !== undefined && retained[0]!.handle.fd >= 0)
      await originalClose.call(retained[0]);
  }
});

it("preserves a read cancellation cause when close also fails", async () => {
  const root = await createTestTempDirectory("rea-stable-hash-primary-");
  const path = join(root, "input.bin");
  await writeFile(path, "owned bytes");
  const primary = new Error("injected cancellation after read");
  const closeCause = new Error("injected close failure after cancellation");
  const controller = new AbortController();
  const nativeOpen = regularFile.openRegularFile;
  const open = vi
    .spyOn(regularFile, "openRegularFile")
    .mockImplementation(async (selectedPath, options) => {
      const descriptor = await nativeOpen(selectedPath, options);
      const { handle } = descriptor;
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        controller.abort(primary);
        throw primary;
      });
      return descriptor;
    });
  const originalClose = OwnedFileHandle.prototype.close;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async () => {
      throw closeCause;
    });
  const retained: OwnedFileHandle[] = [];
  try {
    let failure: unknown;
    try {
      await hashStableFile(path, {
        signal: controller.signal,
        retainFailedClose: (owner) => retained.push(owner),
      });
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected a typed hash cleanup failure");
    expect(failure.outcome).toEqual({ kind: "failed", cause: primary });
    expect(failure.cleanupCause).toBe(closeCause);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors).toEqual([
      primary,
      closeCause,
    ]);
    expect(retained).toEqual([failure.owner]);
    close.mockRestore();
    await failure.owner.close();
    expect(failure.owner.handle.fd).toBe(-1);
  } finally {
    close.mockRestore();
    open.mockRestore();
    if (retained[0] !== undefined && retained[0]!.handle.fd >= 0)
      await originalClose.call(retained[0]);
  }
});

it("closes a normally hashed file without adopting an owner", async () => {
  const root = await createTestTempDirectory("rea-stable-hash-control-");
  const path = join(root, "input.bin");
  await writeFile(path, "owned bytes");
  const retainFailedClose = vi.fn();
  await expect(
    hashStableFile(path, { retainFailedClose }),
  ).resolves.toMatchObject({ bytes: 11 });
  expect(retainFailedClose).not.toHaveBeenCalled();
});

it("retains a completed digest when cancellation follows successful close", async () => {
  const root = await createTestTempDirectory("rea-stable-hash-cancel-");
  const path = join(root, "input.bin");
  const bytes = Buffer.from("owned bytes");
  await writeFile(path, bytes);
  const controller = new AbortController();
  const reason = new Error("caller cancelled during close");
  const retainFailedClose = vi.fn();
  const nativeClose = OwnedFileHandle.prototype.close;
  let observed: OwnedFileHandle | undefined;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async function (this: OwnedFileHandle) {
      observed = this;
      await nativeClose.call(this);
      controller.abort(reason);
    });
  try {
    const failure: unknown = await hashStableFile(path, {
      signal: controller.signal,
      retainFailedClose,
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(RegularFileCancelled);
    if (!(failure instanceof RegularFileCancelled))
      throw new Error(
        "Expected completed file observations under cancellation",
      );
    expect(failure.path).toBe(path);
    expect(failure.reason).toBe(reason);
    expect(failure.owner).toBe(observed);
    expect(failure.outcome).toEqual({
      kind: "completed",
      value: {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    expect(observed?.handle.fd).toBe(-1);
    expect(retainFailedClose).not.toHaveBeenCalled();
  } finally {
    close.mockRestore();
    await observed?.close();
  }
});

it("adopts a descriptor from an admission failure and preserves both causes", async () => {
  const root = await createTestTempDirectory("rea-stable-hash-admission-");
  const path = join(root, "input.bin");
  await writeFile(path, "owned bytes");
  const owner = new OwnedFileHandle(await openFile(path, "r"));
  const primary = new Error("injected file admission failure");
  const cleanupCause = new Error("injected admission descriptor close failure");
  const open = vi
    .spyOn(regularFile, "openRegularFile")
    .mockRejectedValueOnce(
      new RegularFileAdmissionFailure(path, primary, cleanupCause, owner),
    );
  const retained: OwnedFileHandle[] = [];
  try {
    let failure: unknown;
    try {
      await hashStableFile(path, {
        retainFailedClose: (retainedOwner) => retained.push(retainedOwner),
      });
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected a typed admission cleanup failure");
    expect(failure.outcome).toEqual({ kind: "failed", cause: primary });
    expect(failure.cleanupCause).toBe(cleanupCause);
    expect(failure.retention).toEqual({ kind: "callback_returned" });
    expect((failure.cause as AggregateError).errors).toEqual([
      primary,
      cleanupCause,
    ]);
    expect(retained).toEqual([owner]);
  } finally {
    open.mockRestore();
    await owner.close();
  }
});

it("distinguishes a thrown undefined primary failure from a clean hash", async () => {
  const root = await createTestTempDirectory("rea-stable-hash-undefined-");
  const path = join(root, "input.bin");
  await writeFile(path, "owned bytes");
  const openFileAtBoundary = regularFile.openRegularFile;
  const open = vi
    .spyOn(regularFile, "openRegularFile")
    .mockImplementation(async (selectedPath, options) => {
      const descriptor = await openFileAtBoundary(selectedPath, options);
      const { handle } = descriptor;
      vi.spyOn(handle, "stat").mockRejectedValueOnce(undefined);
      return descriptor;
    });
  const closeCause = new Error("injected close failure after undefined");
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockRejectedValueOnce(closeCause);
  const retained: OwnedFileHandle[] = [];
  try {
    let failure: unknown;
    try {
      await hashStableFile(path, {
        retainFailedClose: (owner) => retained.push(owner),
      });
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected a typed hash cleanup failure");
    expect(failure.outcome).toEqual({ kind: "failed", cause: undefined });
    expect(failure.cleanupCause).toBe(closeCause);
    expect((failure.cause as AggregateError).errors).toEqual([
      undefined,
      closeCause,
    ]);
    expect(retained).toEqual([failure.owner]);
  } finally {
    close.mockRestore();
    open.mockRestore();
    if (retained[0] !== undefined) await retained[0].close();
  }
});

it.each([
  { stage: "close", reason: null },
  { stage: "close", reason: "caller stopped" },
  { stage: "close", reason: new Error("caller stopped") },
  { stage: "retention", reason: "after the failed close" },
] as const)(
  "records completion cancellation at $stage before owner handoff",
  async ({ stage, reason }) => {
    const root = await createTestTempDirectory("rea-hash-close-provenance-");
    const path = join(root, "input.bin");
    await writeFile(path, "owned bytes");
    const controller = new AbortController();
    const nativeClose = OwnedFileHandle.prototype.close;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementationOnce(async () => {
        if (stage === "close") controller.abort(reason);
        throw new Error("injected failed close");
      });
    let retained: OwnedFileHandle | undefined;
    try {
      const failure: unknown = await hashStableFile(path, {
        signal: controller.signal,
        retainFailedClose: (owner) => {
          retained = owner;
          if (stage === "retention") controller.abort(reason);
        },
      }).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
      expect(failure).toMatchObject({
        outcome: { kind: "completed", value: { bytes: 11 } },
      });
      if (stage === "close") {
        expect(failure).toMatchObject({ completionCancellation: { reason } });
        expect(
          Reflect.get(failure as object, "completionCancellation").reason,
        ).toBe(reason);
      } else
        expect(failure).not.toHaveProperty(
          "completionCancellation",
          expect.anything(),
        );
    } finally {
      close.mockRestore();
      if (retained !== undefined) await nativeClose.call(retained);
    }
  },
);

it("tags a physical hash failure without inferring cancellation from a later signal", async () => {
  const root = await createTestTempDirectory("rea-hash-physical-provenance-");
  const path = join(root, "input.bin");
  await writeFile(path, "owned bytes");
  const controller = new AbortController();
  const primary = Object.assign(new Error("injected digest read failure"), {
    code: "EIO",
  });
  const nativeOpen = regularFile.openRegularFile;
  const open = vi
    .spyOn(regularFile, "openRegularFile")
    .mockImplementation(async (selected, options) => {
      const descriptor = await nativeOpen(selected, options);
      const { handle } = descriptor;
      vi.spyOn(handle, "read").mockRejectedValueOnce(primary);
      return descriptor;
    });
  const nativeClose = OwnedFileHandle.prototype.close;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async function (this: OwnedFileHandle) {
      await nativeClose.call(this);
      controller.abort(primary);
    });
  try {
    const failure: unknown = await hashStableFile(path, {
      signal: controller.signal,
      retainFailedClose: () => {
        throw new Error("Close succeeded");
      },
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      _tag: "StableFileHashFailure",
      cause: primary,
    });
    if (!(failure instanceof Error))
      throw new Error("Expected producer-owned physical failure");
    expect(failure.cause).toBe(primary);
  } finally {
    open.mockRestore();
    close.mockRestore();
  }
});

it.each([false, true])(
  "preserves premature EOF with same-read cancellation and failed close=%s",
  async (failClose) => {
    const root = await createTestTempDirectory("rea-hash-eof-cancel-");
    const path = join(root, "input.bin");
    await writeFile(path, "admitted extent");
    const controller = new AbortController();
    const nativeOpen = regularFile.openRegularFile;
    let retained: OwnedFileHandle | undefined;
    const open = vi
      .spyOn(regularFile, "openRegularFile")
      .mockImplementation(async (selected, options) => {
        const descriptor = await nativeOpen(selected, options);
        const { handle } = descriptor;
        vi.spyOn(handle, "read").mockImplementationOnce(async () => {
          controller.abort("cancelled at EOF");
          return { bytesRead: 0, buffer: Buffer.alloc(0) };
        });
        return descriptor;
      });
    const nativeClose = OwnedFileHandle.prototype.close;
    const close = vi.spyOn(OwnedFileHandle.prototype, "close");
    if (failClose) close.mockRejectedValueOnce(new Error("close unavailable"));
    try {
      const failure: unknown = await hashStableFile(path, {
        signal: controller.signal,
        retainFailedClose: (owner) => {
          retained = owner;
        },
      }).catch((cause: unknown) => cause);
      const physical =
        failure instanceof RegularFileCleanupFailure
          ? failure.outcome.kind === "failed"
            ? failure.outcome.cause
            : undefined
          : failure instanceof Error
            ? failure.cause
            : undefined;
      expect(physical).toBeInstanceOf(regularFile.RegularFileChangedError);
      if (failClose) {
        expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
        expect(retained?.handle.fd).toBeGreaterThanOrEqual(0);
      } else expect(failure).toMatchObject({ _tag: "StableFileHashFailure" });
    } finally {
      open.mockRestore();
      close.mockRestore();
      if (retained !== undefined) await nativeClose.call(retained);
    }
  },
);

it.each(
  [null, "caller stopped", new Error("caller stopped")].flatMap((reason) =>
    [false, true].map((failClose) => ({ reason, failClose })),
  ),
)(
  "retains the exact read checkpoint reason with failed close=$failClose ($reason)",
  async ({ reason, failClose }) => {
    const root = await createTestTempDirectory("rea-hash-read-checkpoint-");
    const path = join(root, "input.bin");
    await writeFile(path, "admitted bytes");
    const controller = new AbortController();
    const nativeOpen = regularFile.openRegularFile;
    let retained: OwnedFileHandle | undefined;
    let handleSeen:
      | regularFile.StableRegularFileDescriptor["handle"]
      | undefined;
    const open = vi
      .spyOn(regularFile, "openRegularFile")
      .mockImplementation(async (selected, options) => {
        const descriptor = await nativeOpen(selected, options);
        const { handle } = descriptor;
        handleSeen = handle;
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(async (...args) => {
          const result = await read(...args);
          controller.abort(reason);
          return result;
        });
        return descriptor;
      });
    const nativeClose = OwnedFileHandle.prototype.close;
    const close = vi.spyOn(OwnedFileHandle.prototype, "close");
    if (failClose) close.mockRejectedValueOnce(new Error("close unavailable"));
    try {
      const failure: unknown = await hashStableFile(path, {
        signal: controller.signal,
        retainFailedClose: (owner) => {
          retained = owner;
        },
      }).catch((cause: unknown) => cause);
      const primary =
        failure instanceof RegularFileCleanupFailure &&
        failure.outcome.kind === "failed"
          ? failure.outcome.cause
          : failure;
      expect(primary).toBeInstanceOf(regularFile.RegularFileOperationCancelled);
      expect(
        (primary as regularFile.RegularFileOperationCancelled).reason,
      ).toBe(reason);
      expect(handleSeen?.fd).toBe(failClose ? retained?.handle.fd : -1);
    } finally {
      open.mockRestore();
      close.mockRestore();
      if (retained !== undefined) await nativeClose.call(retained);
    }
  },
);
