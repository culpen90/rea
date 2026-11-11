import { skillDestinations, SetupSkillInstallError } from "./SetupSkill.js";
import type {
  ClientConfigurationInspection,
  ClientConfigurationResult,
  SetupHost,
  SetupOptions,
  SetupProviderEnvironment,
} from "./SetupTypes.js";
import type { SetupClient } from "./SupportedClients.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  DoctorProviderInspection,
  DoctorReport,
  DoctorScope,
} from "./Doctor.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "../identity.js";
import { DEFAULT_CATALOG_IDENTITY } from "../catalogIdentity.js";
import type { ClientRegistrationStatus } from "./ClientRegistrationStatus.js";
import { currentClientRegistrationCommand } from "./ClientRegistrationIdentity.js";

/** Recording setup host for service-level planning and recovery tests. */
export class FakeSetupHost implements SetupHost {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory = "/fixture/home";
  skillDestinations(clientIds: readonly string[]) {
    return skillDestinations(this.homeDirectory, clientIds);
  }
  registrationCommand: readonly string[];
  registrationCommandBlocker?: string;
  nodeVersion = "24.22.1";
  ghidra: string | undefined;
  javaHome: string | undefined;
  skill: "installed" | "unchanged" | "failed" = "installed";
  clients: readonly SetupClient[] = [];
  availableClients: readonly SetupClient[] | undefined;
  productRegistrations: readonly ClientRegistrationStatus[] = [];
  clientResults = new Map<string, ClientConfigurationResult>();
  clientInspections = new Map<string, ClientConfigurationInspection>();
  configurations = 0;
  skillInstalls = 0;
  skillDirectoryValidations: Array<readonly string[]> = [];
  doctorCalls = 0;
  doctorScopes: Array<DoctorScope | undefined> = [];
  configuredProviderEnvironments: SetupProviderEnvironment[] = [];
  configuredCommands: Array<readonly string[]> = [];
  doctorHealthy: boolean | undefined;
  scopedDoctorHealthy: boolean | undefined;
  providerInspections: readonly DoctorProviderInspection[] | undefined =
    undefined;

  constructor(platform: NodeJS.Platform = "darwin") {
    this.platform = platform;
    this.registrationCommand = currentClientRegistrationCommand({ platform });
  }

  initialSetupState = async (scope?: DoctorScope) => ({
    providerEnvironment: {
      ...(this.ghidra === undefined ? {} : { GHIDRA_INSTALL_DIR: this.ghidra }),
      ...(this.javaHome === undefined ? {} : { JAVA_HOME: this.javaHome }),
    },
    doctor: await this.doctor(scope),
  });
  detectedClients = (): Promise<readonly SetupClient[]> =>
    Promise.resolve(this.clients);
  supportedClients = (): Promise<readonly SetupClient[]> =>
    Promise.resolve(this.availableClients ?? this.clients);
  configureClient = (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ): Promise<ClientConfigurationResult> => {
    this.configurations += 1;
    this.configuredProviderEnvironments.push(providerEnvironment);
    this.configuredCommands.push(command);
    return Promise.resolve(
      this.clientResults.get(client.name) ?? { status: "configured" },
    );
  };
  inspectClientConfiguration = (
    client: SetupClient,
  ): Promise<ClientConfigurationInspection> =>
    Promise.resolve(
      this.clientInspections.get(client.name) ?? { status: "update" },
    );
  skillNeedsInstall: SetupHost["skillNeedsInstall"] = (): Promise<boolean> =>
    Promise.resolve(this.skill !== "unchanged");
  validateSkillDirectories = (
    clientIds: readonly string[],
  ): Promise<Result<void, SetupSkillInstallError>> => {
    this.skillDirectoryValidations.push(clientIds);
    return Promise.resolve(ok(undefined));
  };
  installSkill = () => {
    this.skillInstalls += 1;
    return Promise.resolve(
      this.skill === "failed"
        ? err(
            new SetupSkillInstallError({
              path: "/fixture/home/.agents/skills/reverse-engineer-anything/SKILL.md",
              stage: "write",
              reason: "injected skill write failure",
              rollbackFailures: [],
              recoveryBackupPaths: [],
              cause: new Error("injected skill write failure"),
            }),
          )
        : ok(this.skill),
    );
  };
  doctor = (scope?: DoctorScope): Promise<DoctorReport> => {
    this.doctorCalls += 1;
    this.doctorScopes.push(scope);
    const environmentHealthy = this.doctorHealthy ?? this.ghidra !== undefined;
    const healthy =
      scope === undefined
        ? environmentHealthy
        : (scope.clients?.length ?? 0) === 0 &&
            (scope.skillClients?.length ?? 0) === 0 &&
            (scope.providers?.length ?? 0) === 0 &&
            scope.skill !== true
          ? true
          : (this.scopedDoctorHealthy ?? environmentHealthy);
    return Promise.resolve({
      healthy,
      environment_healthy: environmentHealthy,
      scope: {
        mode: scope === undefined ? "audit-wide" : "explicit",
        clients: scope?.clients ?? [],
        ...(scope?.skillClients === undefined
          ? {}
          : { skill_clients: scope.skillClients }),
        providers: scope?.providers ?? [],
        skill: scope?.skill === true,
        target: null,
      },
      scope_checks: [],
      informational_checks: [],
      ...(this.providerInspections === undefined
        ? {}
        : { providerInspections: this.providerInspections }),
      checks: [],
      identity: {
        cli_package_version: PRODUCT_IDENTITY.packageVersion,
        expected_skill_version: PRODUCT_IDENTITY.skillVersion,
        sdk: SDK_IDENTITY,
        catalog: DEFAULT_CATALOG_IDENTITY,
        live_server: {
          state: "unknown",
          remediation: "Inspect the running server.",
        },
        installations: { paths: [], state: "unknown" },
        skill: {
          installed_version: null,
          installed_tool_count: null,
          state: this.skill === "unchanged" ? "aligned" : "missing",
          remediation: null,
        },
        registrations: this.productRegistrations,
      },
    });
  };
}

/** Build setup options for approved or planning-only service tests. */
export const options = (approved: boolean): SetupOptions => ({
  approved,
  structured: true,
});
