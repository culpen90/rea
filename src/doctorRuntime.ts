import {
  systemDoctorHost,
  type DoctorHost,
  type DoctorProviderInspection,
} from "./application/Doctor.js";
import { readDesktopBuildFacts } from "./desktop/DesktopBuildDoctorFacts.js";
import {
  JADX_DOCTOR_SETTINGS,
  inspectJadxProvider,
} from "./android/JadxDoctor.js";
import {
  GHIDRA_DOCTOR_SETTINGS,
  inspectSystemGhidraProvider,
} from "./ghidra/GhidraDoctor.js";
import type { RetainedResourceScope } from "./application/AnalysisProvider.js";
import { RegularFileCleanupFailure } from "./filesystem/OwnedRegularFile.js";
import { readEffectiveClientRegistrationConfiguration } from "./application/ClientConfigurationFiles.js";
import { clientRegistrationEnvironmentDetails } from "./application/ClientRegistrationEnvironment.js";
import {
  mergeEnvironmentOverrides,
  snapshotEnvironment,
} from "./process/snapshotEnvironment.js";
import { supportedClients } from "./application/SupportedClients.js";
import { homeDirectoryFromEnvironment } from "./config/homeDirectory.js";
/**
 * A selected client's own environment, when its registration records one.
 * Provider checks read the terminal by default; a caller that asked about one
 * client wants the values that client passes to the server it starts.
 */
interface SelectedRegistrationEnvironment {
  /** The terminal a selected client inherits, overlaid by its registration. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Names the client records as expressions this process cannot evaluate. */
  readonly unresolved: ReadonlySet<string>;
  /** The registration could not be read or its effective settings resolved. */
  readonly unknown?: boolean;
}

const selectedRegistrationEnvironment = async (
  clients: readonly string[],
  processEnvironment: Readonly<NodeJS.ProcessEnv>,
  resourceScope: RetainedResourceScope,
  signal: AbortSignal,
): Promise<SelectedRegistrationEnvironment | undefined> => {
  const [selected] = clients;
  // Only an unambiguous selection can stand for the terminal's environment.
  if (selected === undefined || clients.length !== 1) return undefined;
  signal.throwIfAborted();
  const home = homeDirectoryFromEnvironment(
    processEnvironment,
    process.platform,
  );
  const client = supportedClients(
    home,
    process.platform,
    processEnvironment,
  ).find(({ name }) => name === selected);
  if (client === undefined || client.format === "unsupported")
    return { environment: {}, unresolved: new Set(), unknown: true };
  const registered = await readSelectedRegistration(
    client,
    resourceScope,
    process.platform,
  );
  if (registered === undefined) return undefined;
  if ("unknown" in registered)
    return { environment: {}, unresolved: new Set(), unknown: true };
  return {
    environment: registered.values,
    unresolved: registered.unresolvedSettings,
  };
};

/**
 * Fold a selected registration and the terminal it inherits into the canonical
 * names a provider check reads: the registration's recorded values win, names
 * it records as unreadable expressions are dropped, and everything else
 * survives from the terminal.
 *
 * Windows treats setting names case-insensitively, so a registration recording
 * `ghidra_install_dir` must override the terminal's `GHIDRA_INSTALL_DIR`
 * rather than sit beside it, and a dropped expression must be found under
 * either spelling. `snapshotEnvironment` performs that fold;
 * `mergeEnvironmentOverrides` alone keeps the winning layer's spelling.
 */
export const selectedProviderSettings = (
  selected: SelectedRegistrationEnvironment | undefined,
  terminal: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, string | undefined>> => {
  if (selected === undefined) return terminal;
  const settings: Record<string, string | undefined> = {
    ...snapshotEnvironment(
      mergeEnvironmentOverrides(terminal, selected.environment, platform),
      platform,
    ),
  };
  for (const name of Object.keys(
    snapshotEnvironment(
      Object.fromEntries(
        [...selected.unresolved].map((entry): [string, string] => [entry, ""]),
      ),
      platform,
    ),
  ))
    delete settings[name];
  return settings;
};

type SelectedRegistration = {
  readonly values: Readonly<Record<string, string>>;
  readonly unresolvedSettings: ReadonlySet<string>;
};

/** Read the selected client's registration, or report it as unreadable. */
const readSelectedRegistration = async (
  client: Parameters<typeof readEffectiveClientRegistrationConfiguration>[0],
  resourceScope: RetainedResourceScope,
  platform: NodeJS.Platform,
): Promise<SelectedRegistration | { readonly unknown: true } | undefined> => {
  // A failed close is a retained owner, not a read outcome: transfer it to the
  // caller's scope so `close()` retries it instead of losing it.
  const configuration = await resourceScope
    .run(() =>
      readEffectiveClientRegistrationConfiguration(client, undefined, platform),
    )
    .catch((cause: unknown) => {
      if (cause instanceof RegularFileCleanupFailure) {
        resourceScope.retain(cause.owner, cause.path);
        return undefined;
      }
      throw cause;
    });
  // A registration this process cannot read says nothing about the values the
  // client passes on; the terminal is not those values.
  if (configuration === undefined) return { unknown: true };
  if (!configuration.ok) {
    const cleanup = configuration.error.cleanupFailure;
    if (cleanup !== undefined)
      resourceScope.retain(cleanup.owner, cleanup.path);
    return { unknown: true };
  }
  if (configuration.value.document === undefined) return undefined;
  const details = clientRegistrationEnvironmentDetails(
    configuration.value.document,
    client.name,
    {},
    "effective",
    platform,
  );
  return details.ok
    ? {
        values: details.value.values,
        unresolvedSettings: details.value.unresolvedSettings,
      }
    : { unknown: true };
};

/** Registration settings read by each provider's readiness probe. */
const PROVIDER_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  ghidra: GHIDRA_DOCTOR_SETTINGS,
  jadx: JADX_DOCTOR_SETTINGS,
};

/**
 * Whether a setting an unresolved expression removed is one this probe actually
 * reads for the configuration the client supplied. A literal `JAVA_HOME` and
 * jar path make JADX never consult `PATH`, so failing that probe closed would
 * report `unknown` for a provider that has everything it needs.
 */
export const settingAffectsProbe = (
  id: string,
  name: string,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): boolean => {
  const read = (key: string) =>
    environment[platform === "win32" ? key.toUpperCase() : key];
  switch (id) {
    case "jadx":
      // Java comes from JAVA_HOME when it is explicit; only then is PATH unused.
      return name !== "PATH" || read("JAVA_HOME") === undefined;
    case "ghidra":
      // Both the install directory and the JDK fall back to PATH lookups.
      return (
        name !== "PATH" ||
        read("GHIDRA_INSTALL_DIR") === undefined ||
        read("JAVA_HOME") === undefined
      );
    default:
      return true;
  }
};

const unresolvedProvider = (
  id: string,
  selected: SelectedRegistrationEnvironment | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): DoctorProviderInspection | undefined => {
  if (selected === undefined) return undefined;
  const normalize = (key: string) =>
    platform === "win32" ? key.toUpperCase() : key;
  const read = new Set((PROVIDER_SETTINGS[id] ?? []).map(normalize));
  const unresolved = [...selected.unresolved].filter(
    (name) =>
      read.has(normalize(name)) &&
      settingAffectsProbe(id, normalize(name), environment, platform),
  );
  if (selected.unknown !== true && unresolved.length === 0) return undefined;
  const configurationKeys: Readonly<Record<string, string>> = {
    ghidra: "GHIDRA_INSTALL_DIR",
    jadx: "REA_JADX_MCP_JAR",
  };
  const configurationKey = configurationKeys[id];
  const unknownConfiguration =
    selected.unknown === true ||
    configurationKey === undefined ||
    unresolved.some((name) => normalize(name) === normalize(configurationKey));
  const configuration =
    configurationKey === undefined ? undefined : environment[configurationKey];
  return {
    id,
    configured: unknownConfiguration ? null : configuration !== undefined,
    available: null,
    providerVersion: null,
    registrationEnvironment: {},
    checks: [
      {
        name: "configuration",
        ok: false,
        code: "registration_environment_unknown",
        classification: "unknown",
        detail:
          selected.unknown === true
            ? "The selected client's registration could not be read or resolved."
            : `The selected client's registration has unresolved settings: ${unresolved.join(", ")}.`,
        remediation:
          "Inspect the selected client's registration on the host and rerun doctor.",
      },
    ],
  };
};

/** Compose provider diagnostics at the outer CLI adapter boundary. */
export const createSystemDoctorHost = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  signal?: AbortSignal,
): DoctorHost => {
  return systemDoctorHost({
    environment,
    ...(signal === undefined ? {} : { signal }),
    providerInspections: async (
      resourceScope: RetainedResourceScope,
      inspectionSignal: AbortSignal,
      clients: readonly string[],
    ) => {
      const selected = await selectedRegistrationEnvironment(
        clients,
        environment,
        resourceScope,
        inspectionSignal,
      );
      const { REA_TARGET_PATH: _targetPath, ...inspectionEnvironment } =
        selectedProviderSettings(selected, environment);
      return [
        unresolvedProvider(
          "ghidra",
          selected,
          inspectionEnvironment,
          process.platform,
        ) ??
          (await inspectSystemGhidraProvider(
            inspectionEnvironment,
            resourceScope,
            inspectionSignal,
          )),
        unresolvedProvider(
          "jadx",
          selected,
          inspectionEnvironment,
          process.platform,
        ) ??
          (await inspectJadxProvider(
            inspectionEnvironment,
            resourceScope,
            inspectionSignal,
          )),
      ] satisfies readonly DoctorProviderInspection[];
    },
    desktopBuildFacts: readDesktopBuildFacts,
  });
};
