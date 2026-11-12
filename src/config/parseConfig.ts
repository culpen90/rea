import type {
  ConfigurationError,
  ConfigurationSettingIssue,
} from "../domain/configurationErrors.js";
import { ok, type Result } from "../domain/result.js";
import { launchAnalysisSetting } from "./analysisSettings.js";
import type { AnalysisSettingId } from "../domain/analysisSettings.js";
import { parseEnvironment } from "./environment.js";
import { DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS } from "../domain/analysisResourceLimits.js";
import { DEFAULT_BRIDGE_MAX_REQUEST } from "./bridgeMaxRequestBytes.js";
import type { AppConfig } from "./types.js";
/**
 * Environment native analysis admits. JEB validates its own settings during
 * optional provider composition; that setting must not block unrelated
 * CLI/MCP startup. Registration validation still checks it directly.
 */
const nativeAnalysisEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> => {
  const {
    REA_JEB_MCP_TIMEOUT_MS: _jebTimeout,
    REA_JEB_MCP_URL: _jebUrl,
    ...appEnvironment
  } = environment;
  return appEnvironment;
};

/** Native admission issues collected without probing providers. */
export interface NativeAnalysisConfigurationInspection {
  readonly issues: readonly ConfigurationSettingIssue[];
}

/** Inspect native admission without probing launchers or losing mixed-invalid diagnostics. */
export const inspectNativeAnalysisConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
): NativeAnalysisConfigurationInspection => {
  const parsed = parseEnvironment(nativeAnalysisEnvironment(environment));
  return { issues: parsed.ok ? [] : parsed.error.settings };
};

/** Parse provider configuration and runtime prerequisites at the composition root. */
export const parseConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<AppConfig, ConfigurationError> => {
  const parsed = parseEnvironment(nativeAnalysisEnvironment(environment));
  if (!parsed.ok) return parsed;
  const env = parsed.value;
  const invalidRuntimeSeeds: Partial<
    Record<AnalysisSettingId, ConfigurationError>
  > = {};
  const admitted = (id: AnalysisSettingId): number | null | undefined => {
    const result = launchAnalysisSetting(id, environment);
    if (result.ok) return result.value.value;
    invalidRuntimeSeeds[id] = result.error;
    return undefined;
  };
  const ghidraStartup = admitted("ghidra.startup_timeout_ms");
  const decompileTimeout = admitted("ghidra.decompile_timeout_seconds");
  const decompilePayload = admitted("ghidra.decompile_max_payload_mib");
  const valueFlowOperations = admitted("ghidra.value_flow_max_operations");
  const valueFlowInputs = admitted(
    "ghidra.value_flow_max_inputs_per_operation",
  );
  const valueFlowEdges = admitted("ghidra.value_flow_max_edges");
  const bridgeBytes = admitted("bridge.max_request_bytes");
  return ok({
    ...(env.REA_MCP_TOOL_FAMILIES === undefined
      ? {}
      : { mcpToolFamilies: env.REA_MCP_TOOL_FAMILIES }),
    ...(env.REA_MCP_MAX_RESPONSE_BYTES === undefined
      ? {}
      : { mcpMaxResponseBytes: env.REA_MCP_MAX_RESPONSE_BYTES }),
    ...(env.REA_MCP_MAX_INPUT_ELEMENTS === undefined
      ? {}
      : { mcpMaxInputElements: env.REA_MCP_MAX_INPUT_ELEMENTS }),
    ...(env.REA_MCP_INPUT_SCHEMA_PROFILE === undefined
      ? {}
      : { mcpInputSchemaProfile: env.REA_MCP_INPUT_SCHEMA_PROFILE }),
    ...(env.REA_MCP_OUTPUT_SCHEMA_PROFILE === undefined
      ? {}
      : { mcpOutputSchemaProfile: env.REA_MCP_OUTPUT_SCHEMA_PROFILE }),
    ...(env.REA_MCP_TOOL_CATALOG_PROFILE === undefined
      ? {}
      : { mcpToolCatalogProfile: env.REA_MCP_TOOL_CATALOG_PROFILE }),
    analysisProvider: env.REA_ANALYSIS_PROVIDER,
    ...(env.REA_GHIDRA_PROJECT_PATH === undefined
      ? {}
      : {
          ghidraExistingProject: {
            path: env.REA_GHIDRA_PROJECT_PATH,
            ...(env.REA_GHIDRA_PROGRAM_NAME === undefined
              ? {}
              : { programName: env.REA_GHIDRA_PROGRAM_NAME }),
          },
        }),
    ghidraInstallDir: env.GHIDRA_INSTALL_DIR,
    ...(env.REA_GHIDRA_CHECKPOINT_DIR === undefined
      ? {}
      : { ghidraCheckpointDirectory: env.REA_GHIDRA_CHECKPOINT_DIR }),
    ghidraJavaHome: env.JAVA_HOME,
    ghidraStartupTimeoutMs: ghidraStartup ?? DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS,
    ...(decompilePayload === undefined || decompilePayload === null
      ? {}
      : { ghidraDecompileMaxPayloadMiB: decompilePayload }),
    ...(valueFlowOperations === undefined || valueFlowOperations === null
      ? {}
      : { ghidraValueFlowMaxOperations: valueFlowOperations }),
    ...(valueFlowInputs === undefined || valueFlowInputs === null
      ? {}
      : { ghidraValueFlowMaxInputsPerOperation: valueFlowInputs }),
    ...(valueFlowEdges === undefined || valueFlowEdges === null
      ? {}
      : { ghidraValueFlowMaxEdges: valueFlowEdges }),
    ...(decompileTimeout === undefined || decompileTimeout === null
      ? {}
      : { ghidraDecompileTimeoutSeconds: decompileTimeout }),
    ...(env.REA_GHIDRA_LANGUAGE_ID === undefined
      ? {}
      : {
          ghidraLanguageOverride: {
            languageId: env.REA_GHIDRA_LANGUAGE_ID,
            ...(env.REA_GHIDRA_COMPILER_SPEC_ID === undefined
              ? {}
              : { compilerSpecId: env.REA_GHIDRA_COMPILER_SPEC_ID }),
          },
        }),
    ...(env.REA_GHIDRA_SEED_FILE === undefined
      ? {}
      : { ghidraSeedFile: env.REA_GHIDRA_SEED_FILE }),
    ...(env.REA_GHIDRA_DISABLED_ANALYZERS === undefined
      ? {}
      : { ghidraDisabledAnalyzers: env.REA_GHIDRA_DISABLED_ANALYZERS }),
    ...(env.REA_GHIDRA_NATIVEAOT_JAR === undefined
      ? {}
      : { ghidraNativeAotJar: env.REA_GHIDRA_NATIVEAOT_JAR }),
    ilspyCmdPath: env.REA_ILSPY_CMD_PATH,
    initialTargetPath: env.REA_TARGET_PATH,
    logLevel: env.REA_LOG_LEVEL,
    referenceSourcePolicy: {
      secretPatterns: env.referenceSecretPatterns,
    },
    bridgeMaxRequestBytes:
      bridgeBytes === undefined ||
      bridgeBytes === null ||
      environment.REA_BRIDGE_MAX_REQUEST_BYTES === undefined
        ? DEFAULT_BRIDGE_MAX_REQUEST
        : {
            maximumBytes: bridgeBytes,
            source: "setting",
          },
    invalidRuntimeSeeds,
  });
};
