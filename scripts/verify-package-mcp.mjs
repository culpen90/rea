import {
  requireMcpEvidenceBundle,
  requireMcpLifecycleResult,
  requireMcpOutput,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { readFile, realpath, rm } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PRODUCT_IDENTITY } from "../dist/identity.js";
import { resolveMcpStartupBudgets } from "../dist/config/mcpStartupBudgets.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import * as prompts from "./verify-package-prompts.mjs";
import { assertUnconfiguredGhidra } from "./verify-package-platform.mjs";
import { verifyCompleteToolCatalog } from "./lib/verify-package-core.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";

const verifyMcpToolsAndPrompts = async (client, mcpOptions) => {
  await verifyCompleteToolCatalog(client, mcpOptions);
  await prompts.verifyPromptCatalog(client, mcpOptions, prompts.names);
  await prompts.verifyPromptCompletion(client, mcpOptions, []);
};

const verifyMcpTargetFree = async (client, mcpOptions) => {
  const result = await client.callTool(
    { name: "binary_session", arguments: {} },
    mcpOptions,
  );
  const status = requireMcpLifecycleResult(result, "binary_session");
  const decompile = status.tool_availability.find(
    ({ name }) => name === "procedure_pseudo_code",
  );
  if (decompile?.available !== false || decompile.reason !== "target_required")
    throw new Error(
      "packaged target-free MCP omitted target-bound availability metadata",
    );
};

const verifyMcpUnknownProvider = async (client, mcpOptions) => {
  const unknownProvider = await client.callTool(
    {
      name: "open_binary",
      arguments: {
        path: process.execPath,
        provider_id: "missing-provider",
      },
    },
    mcpOptions,
  );
  if (
    unknownProvider.isError !== true ||
    requireMcpToolError(unknownProvider)?.details?.selection_reason !==
      "unknown_provider"
  )
    throw new Error("packaged MCP accepted an unknown analysis provider");
};

const verifyMcpUnavailableGhidra = async (client, mcpOptions) => {
  const opened = await client.callTool(
    {
      name: "open_binary",
      arguments: { path: process.execPath, provider_id: "ghidra" },
    },
    mcpOptions,
  );
  assertUnconfiguredGhidra(requireMcpToolError(opened), "ghidra");
  await verifyMcpTargetFree(client, mcpOptions);
  await prompts.verifyPromptCompletion(client, mcpOptions, []);
};

const verifyMcpEvidenceBundle = async (client, mcpOptions, evidenceRoot) => {
  const mcpBundlePath = join(evidenceRoot, "mcp.json");
  const mcpExport = await client.callTool(
    { name: "export_evidence_bundle", arguments: { path: mcpBundlePath } },
    mcpOptions,
  );
  if (mcpExport.isError === true)
    throw new Error("packaged MCP evidence export failed");
  const mcpImport = await client.callTool(
    { name: "import_evidence_bundle", arguments: { path: mcpBundlePath } },
    mcpOptions,
  );
  if (mcpImport.isError === true)
    throw new Error("packaged MCP evidence import failed");
};

const verifyMcpInlineArtifactEvidence = async (
  client,
  mcpOptions,
  artifactArchive,
) => {
  const opened = await client.callTool(
    { name: "open_binary", arguments: { path: artifactArchive } },
    mcpOptions,
  );
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  let outputRoot;
  try {
    const inspected = await client.callTool(
      { name: "inspect_artifact", arguments: {} },
      mcpOptions,
    );
    assert.notEqual(inspected.structuredContent, undefined);
    const source = parseEvidence(
      requireMcpOutput(inspected, "inspect_artifact"),
    );
    const compared = await client.callTool(
      {
        name: "compare_artifacts",
        arguments: {
          left: source,
          right: source,
        },
      },
      mcpOptions,
    );
    assert.notEqual(compared.structuredContent, undefined);
    const comparison = parseEvidence(
      requireMcpOutput(compared, "compare_artifacts"),
    );
    assert.ok(comparison.evidence_links.includes(source.evidence_id));
    const bundleReply = await client.callTool(
      { name: "get_evidence_bundle", arguments: {} },
      mcpOptions,
    );
    assert.ok(
      bundleReply.structuredContent,
      "MCP omitted structured Evidence bundle",
    );
    const bundle = requireMcpEvidenceBundle(bundleReply);
    for (const evidence of [source, comparison]) {
      assert.deepEqual(
        bundle.records.find(
          (record) => record.evidence_id === evidence.evidence_id,
        ),
        evidence,
      );
    }
    const extracted = await client.callTool(
      { name: "extract_artifact", arguments: {} },
      mcpOptions,
    );
    assert.notEqual(extracted.structuredContent, undefined);
    const extraction = parseEvidence(
      requireMcpOutput(extracted, "extract_artifact"),
    );
    const materialized = extraction.normalized_result;
    assert.equal(typeof materialized?.output_root, "string");
    outputRoot = materialized.output_root;
    assert.equal(materialized.containment_verified, true);
    assert.equal(
      await readFile(join(outputRoot, "app/main.js"), "utf8"),
      "main();",
    );
  } finally {
    try {
      const closed = await client.callTool(
        { name: "close_binary", arguments: {} },
        mcpOptions,
      );
      assert.notEqual(closed.isError, true, JSON.stringify(closed));
    } finally {
      if (outputRoot !== undefined)
        await rm(outputRoot, { recursive: true, force: true });
    }
  }
};

/** Check CLI diagnostics, then verify catalog and Evidence through the installed plugin. */
export async function verifyPackageMcp({
  commands,
  cli,
  environment,
  evidenceRoot,
  artifactArchive,
}) {
  const diagnosed = JSON.parse(
    (
      await commands.exec(process.execPath, [cli, "mcp", "doctor", "--json"], {
        env: environment,
        timeout: resolveMcpStartupBudgets(environment).doctor.milliseconds,
      })
    ).stdout,
  );
  if (
    diagnosed.healthy !== true ||
    diagnosed.inventory?.tools?.observed !==
      diagnosed.inventory?.tools?.expected
  )
    throw new Error("packaged production MCP doctor failed");
  const scriptsDirectory = dirname(await realpath(cli));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(scriptsDirectory, "plugin-mcp-launcher.mjs"),
      PRODUCT_IDENTITY.packageVersion,
    ],
    env: {
      ...environment,
      REA_ANALYSIS_PROVIDER: undefined,
      GHIDRA_INSTALL_DIR: undefined,
    },
    stderr: "pipe",
  });
  let mcpStderr = "";
  transport.stderr?.on("data", (chunk) => {
    mcpStderr += chunk.toString();
  });
  const client = new Client({ name: "package-smoke", version: "1.0.0" });
  await withVerifierCleanup(async () => {
    try {
      await client.connect(transport);
      const mcpOptions = { timeout: 15_000 };
      await verifyMcpToolsAndPrompts(client, mcpOptions);
      await verifyMcpTargetFree(client, mcpOptions);
      await verifyMcpUnknownProvider(client, mcpOptions);
      await verifyMcpUnavailableGhidra(client, mcpOptions);
      await verifyMcpInlineArtifactEvidence(
        client,
        mcpOptions,
        artifactArchive,
      );
      await verifyMcpEvidenceBundle(client, mcpOptions, evidenceRoot);
    } catch (cause) {
      throw new Error(`packaged MCP smoke failed: ${mcpStderr}`, { cause });
    }
  }, [
    async () => {
      try {
        await client.close();
      } catch (cause) {
        commands.adopt(client, "packaged MCP client");
        throw cause;
      }
    },
    async () => {
      try {
        await transport.close();
      } catch (cause) {
        commands.adopt(transport, "packaged MCP transport");
        throw cause;
      }
    },
  ]);
}
