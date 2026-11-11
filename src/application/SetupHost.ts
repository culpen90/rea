import {
  isClientConfigurationCleanupFailure,
  retryClientConfigurationCleanup,
} from "./ClientConfigurationCleanup.js";
import { access } from "node:fs/promises";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { currentClientRegistrationCommand } from "./ClientRegistrationIdentity.js";
import {
  SUPPORTED_NODE_VERSION_PROSE,
  supportsNodeVersion,
} from "../domain/runtimeVersion.js";
import {
  runDoctor,
  systemDoctorHost,
  type DoctorHost,
  type DoctorScope,
} from "./Doctor.js";
import {
  clientEvidencePaths,
  supportedClients,
  type SetupClient,
} from "./SupportedClients.js";
import {
  skillDestinations,
  canonicalSkillNeedsInstall,
  installCanonicalSkill,
  validateCanonicalSkillDirectories,
} from "./SetupSkill.js";
import {
  ClientConfigurationCleanupRollbackFailure,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "./SetupClientConfiguration.js";
import { failedConfigurationMessage } from "./SetupClients.js";
import {
  explicitSetupRegistrationEnvironment,
  providerRegistrationEnvironment,
} from "./SetupRegistrationEnvironment.js";
import {
  msixPackagesDirectory,
  packagePrivateLauncherBlocker,
} from "./MsixPackageStorage.js";
import type {
  SetupHost,
  SetupInitialState,
  SetupProviderEnvironment,
} from "./SetupTypes.js";
import { SetupCleanupOwner } from "./SetupCleanupOwner.js";
import {
  AnalysisCleanupLeaseGroup,
  type AnalysisCleanupLease,
} from "../artifacts/AnalysisCleanupLease.js";
import { bindRegularFileCleanup } from "./RegularFileRead.js";
import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";
import { systemDesktopBuildSetupHost } from "../desktop/DesktopBuildSetupHost.js";

/**
 * The launcher setup registers, and why it must not be registered when it
 * exists only inside one MSIX package's private storage.
 */
const setupRegistration = (
  platform: NodeJS.Platform,
  homeDirectory: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Pick<SetupHost, "registrationCommand" | "registrationCommandBlocker"> => {
  const registrationCommand = currentClientRegistrationCommand({
    platform,
    entrypointPath: CURRENT_ENTRYPOINT_PATH,
    environment,
  });
  const registrationCommandBlocker =
    registrationCommand.length === 0
      ? "REA could not determine the current executable entrypoint. Run setup through the installed REA CLI or a supported package runner before configuring clients."
      : platform === "win32"
        ? packagePrivateLauncherBlocker(
            registrationCommand,
            msixPackagesDirectory(homeDirectory, environment),
          )
        : undefined;
  return registrationCommandBlocker === undefined
    ? { registrationCommand }
    : { registrationCommand, registrationCommandBlocker };
};

/** Refuse a Node.js runtime REA does not support before any setup work. */
export const hostRemediation = (host: SetupHost): string | undefined =>
  supportsNodeVersion(host.nodeVersion)
    ? undefined
    : `Install ${SUPPORTED_NODE_VERSION_PROSE} and rerun setup.`;

/** Production setup effects for agent configuration and the canonical skill directory. */
export const systemSetupHost = (
  selectedDoctorHost: DoctorHost | undefined = undefined,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): SetupHost => {
  const doctorHost = selectedDoctorHost ?? systemDoctorHost({ environment });
  const platform = doctorHost.platform;
  const { homeDirectory } = doctorHost;
  const resources = new ArtifactResourceScope();
  const registration = setupRegistration(platform, homeDirectory, environment);
  const cleanup = new SetupCleanupOwner([
    {
      rejectedPrefix: "Doctor host cleanup failed",
      close: async () => doctorHost.close?.(),
    },
    { close: () => resources.close() },
  ]);
  return {
    platform,
    homeDirectory,
    skillDestinations: (clientIds) =>
      skillDestinations(homeDirectory, clientIds, environment, platform),
    ...registration,
    nodeVersion: process.versions.node,
    close: () => cleanup.close(),
    initialSetupState: async (
      scope?: DoctorScope,
    ): Promise<SetupInitialState> => {
      const diagnosis = await runDoctor(undefined, doctorHost, scope);
      const providerEnvironment: SetupProviderEnvironment = {
        ...providerRegistrationEnvironment(diagnosis.providerInspections ?? []),
        ...explicitSetupRegistrationEnvironment(environment),
      };
      return {
        providerEnvironment,
        doctor: diagnosis,
      };
    },
    detectedClients: () => detectClients(homeDirectory, platform, environment),
    supportedClients: () =>
      Promise.resolve(supportedClients(homeDirectory, platform, environment)),
    ...clientConfigurationOperations(resources),
    skillNeedsInstall: (clientIds) =>
      canonicalSkillNeedsInstall(
        homeDirectory,
        clientIds,
        environment,
        platform,
        resources,
      ),
    validateSkillDirectories: (clientIds) =>
      validateCanonicalSkillDirectories(
        homeDirectory,
        clientIds,
        environment,
        platform,
      ),
    installSkill: (clientIds) =>
      installCanonicalSkill(
        homeDirectory,
        clientIds,
        environment,
        platform,
        undefined,
        resources,
      ),
    doctor: (scope) => runDoctor(undefined, doctorHost, scope),
    desktopBuild: desktopBuildHost(doctorHost, environment, resources),
  };
};

const desktopBuildHost = (
  doctorHost: DoctorHost,
  environment: Readonly<NodeJS.ProcessEnv>,
  resources: ArtifactResourceScope,
) =>
  systemDesktopBuildSetupHost(
    environment,
    doctorHost.platform,
    doctorHost.clientRegistrations,
    resources,
  );

const clientConfigurationOperations = (resources: ArtifactResourceScope) => ({
  configureClient: (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ) =>
    runClientConfigurationOperation(resources, async () =>
      client.format === "unsupported"
        ? { status: "skipped" as const }
        : configureClientConfiguration(client, providerEnvironment, command),
    ),
  inspectClientConfiguration: (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ) =>
    runClientConfigurationOperation(resources, () =>
      inspectClientConfiguration(client, providerEnvironment, command),
    ),
});

const runClientConfigurationOperation = async <Value>(
  resources: ArtifactResourceScope,
  operation: () => Promise<Value>,
): Promise<Value> => {
  try {
    return await resources.run(async () => {
      try {
        return await operation();
      } catch (cause: unknown) {
        if (!isClientConfigurationCleanupFailure(cause)) throw cause;
        const cleanup = await retryClientConfigurationCleanup(cause, resources);
        const rollback = cleanup.failures.find(
          (failure) =>
            failure instanceof ClientConfigurationCleanupRollbackFailure,
        );
        const rollbackMessage =
          rollback instanceof ClientConfigurationCleanupRollbackFailure
            ? ` ${failedConfigurationMessage(rollback.configurationFailure)}`
            : "";
        throw configurationCleanupError(
          `Could not safely access client configuration at ${cause.path}: ${errorMessage(cleanup.primary)}.${rollbackMessage}`,
          cause,
          cleanup.cleanup,
          cleanup.cleanupLeases,
        );
      }
    });
  } catch (cause: unknown) {
    if (cause instanceof ArtifactReaderFailure)
      throw configurationCleanupError(cause.message, cause, cause.cleanup);
    throw cause;
  }
};

const configurationCleanupError = (
  message: string,
  cause: unknown,
  cleanup:
    | { readonly reason: string; readonly resources: readonly string[] }
    | undefined,
  leases?: readonly AnalysisCleanupLease[],
): ConfigurationError => {
  const error = new ConfigurationError(message, {
    cause,
    settings: [{ setting: "client configuration", constraint: message }],
    ...(cleanup === undefined ? {} : { cleanup }),
  });
  if (leases !== undefined) new AnalysisCleanupLeaseGroup(error, leases);
  else bindRegularFileCleanup(cause, error);
  return error;
};

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Detect supported agents from their config files or stable installation markers. */
export const detectClients = async (
  home: string,
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<readonly SetupClient[]> => {
  const detected: SetupClient[] = [];
  for (const candidate of supportedClients(home, platform, environment)) {
    if (candidate.configPathError !== undefined) continue;
    if (await clientEvidencePresent(candidate)) detected.push(candidate);
  }
  return detected;
};

const clientEvidencePresent = async (client: SetupClient): Promise<boolean> => {
  for (const path of clientEvidencePaths(client))
    if (await exists(path)) return true;
  return false;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (cause: unknown) {
    // best-effort cleanup: optional host probing; absence means unavailable.
    void cause;
    return false;
  }
};
