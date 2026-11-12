import { SetupSkillInstallError, type SkillDestination } from "./SetupSkill.js";
import type {
  ClientConfigurationInspection,
  SetupAction,
  SetupClientState,
  SetupHost,
  SetupProviderEnvironment,
} from "./SetupTypes.js";
import {
  appDataRedirection,
  registrationPersistenceDetail,
  type SetupClient,
} from "./SupportedClients.js";
import { redirectedWriteBlocker } from "./MsixPackageStorage.js";
import type { DoctorReport } from "./Doctor.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
/** Read-only setup facts shared by client selection and preflight. */
export interface SetupDiscovery {
  readonly initialDoctor: Awaited<ReturnType<SetupHost["doctor"]>>;
  readonly clients: readonly SetupClient[];
  readonly detectedClientIds: readonly string[];
  readonly defaultClientIds: readonly string[];
  readonly clientStates: readonly SetupClientState[];
}

/** Discover supported clients and current registrations without mutation. */
export const discoverSetupState = async (input: {
  readonly host: SetupHost;
  readonly initialDoctor: DoctorReport;
}): Promise<SetupDiscovery> => {
  const { initialDoctor } = input;
  const [clients, detectedClients] = await Promise.all([
    input.host.supportedClients(),
    input.host.detectedClients(),
  ]);
  const detectedIds = new Set(detectedClients.map(({ name }) => name));
  const registrations = initialDoctor.identity?.registrations ?? [];
  const registrationByClient = new Map(
    registrations.map((registration) => [registration.client, registration]),
  );
  const clientStates = clients.map((client): SetupClientState => {
    const registration = registrationByClient.get(client.name);
    const commandIdentity = registration?.command_identity;
    const ownedRegistration =
      (registration?.state === "aligned" || registration?.state === "stale") &&
      commandIdentity === "owned";
    const configured = ownedRegistration;
    const status: SetupClientState["status"] =
      registration?.state === "invalid"
        ? "invalid"
        : registration?.state === "unknown" ||
            ((registration?.state === "aligned" ||
              registration?.state === "stale") &&
              commandIdentity === "unknown")
          ? "unknown"
          : ownedRegistration && registration.state === "aligned"
            ? "configured"
            : ownedRegistration && registration.state === "stale"
              ? "needs_configuration"
              : detectedIds.has(client.name)
                ? "needs_configuration"
                : "missing";
    return {
      client,
      detected: detectedIds.has(client.name),
      configured,
      status,
    };
  });
  const defaultClientIds = registrations
    .filter(
      (registration) =>
        (registration.state === "aligned" || registration.state === "stale") &&
        registration.command_identity === "owned",
    )
    .map(({ client }) => client);
  return {
    initialDoctor,
    clients,
    detectedClientIds: detectedClients
      .filter(({ format }) => format !== "unsupported")
      .map(({ name }) => name),
    defaultClientIds,
    clientStates,
  };
};

/** Preflight exactly the selected clients and produce their concrete actions. */
export const planSetupActions = async (input: {
  readonly discovery: SetupDiscovery;
  readonly host: SetupHost;
  readonly providerEnvironment: SetupProviderEnvironment;
  readonly command: readonly string[];
  readonly clientIds: readonly string[];
  readonly skillClientIds: readonly string[];
  readonly installSkill: boolean;
  /** Settings added to one client's registration only, by client id. */
  readonly clientEnvironments?:
    | Readonly<Record<string, SetupProviderEnvironment>>
    | undefined;
}): Promise<{
  readonly plannedActions: readonly SetupAction[];
  readonly selectedClients: readonly SetupClient[];
  readonly clientsToConfigure: readonly SetupClient[];
  readonly blocker?: string;
}> => {
  const byId = new Map(
    input.discovery.clients.map((client) => [client.name, client]),
  );
  const unknownClient = input.clientIds.find((id) => !byId.has(id));
  if (unknownClient !== undefined) {
    return {
      plannedActions: [],
      selectedClients: [],
      clientsToConfigure: [],
      blocker: `Unsupported setup client: ${unknownClient}.`,
    };
  }
  const selectedClients = input.clientIds.flatMap((id) => {
    const client = byId.get(id);
    return client === undefined ? [] : [client];
  });
  if (
    selectedClients.length > 0 &&
    input.host.registrationCommandBlocker !== undefined
  )
    return {
      plannedActions: [],
      selectedClients,
      clientsToConfigure: [],
      blocker: input.host.registrationCommandBlocker,
    };
  const inspections = await inspectSelectedClients(input, selectedClients);
  if ("blocker" in inspections)
    return {
      plannedActions: [],
      selectedClients,
      clientsToConfigure: [],
      blocker: inspections.blocker,
    };
  let skillDestinations: readonly SkillDestination[] = [];
  try {
    if (input.installSkill)
      skillDestinations = input.host.skillDestinations(input.skillClientIds);
  } catch (cause: unknown) {
    if (!(cause instanceof SetupSkillInstallError)) throw cause;
    return {
      plannedActions: [],
      selectedClients,
      clientsToConfigure: [],
      blocker: cause.remediation,
    };
  }
  const clientPlans = plannedClientWrites(inspections);
  const plannedActions = setupPlan({
    installSkill: input.installSkill,
    skillDestinations,
    clients: clientPlans,
    providerEnvironment: input.providerEnvironment,
    clientEnvironments: input.clientEnvironments,
    command: input.command,
  });
  const blocker =
    (clientPlans.length > 0
      ? input.host.registrationCommandBlocker
      : undefined) ??
    redirectedWriteBlocker(
      appDataRedirection(input.discovery.clients),
      plannedActions.map(({ target }) => target),
      "setup",
    );
  return {
    plannedActions,
    selectedClients,
    clientsToConfigure: selectedClients.filter((client) =>
      clientPlans.some(({ client: planned }) => planned.name === client.name),
    ),
    ...(blocker === undefined ? {} : { blocker }),
  };
};

/** Inspect each selected client's registration; the first invalid one blocks the plan. */
const inspectSelectedClients = async (
  input: Parameters<typeof planSetupActions>[0],
  selectedClients: readonly SetupClient[],
): Promise<
  | readonly {
      readonly client: SetupClient;
      readonly inspection: ClientConfigurationInspection;
    }[]
  | { readonly blocker: string }
> => {
  const inspections = await Promise.all(
    selectedClients.map(async (client) => ({
      client,
      inspection: await input.host.inspectClientConfiguration(
        client,
        clientEnvironment(input, client.name),
        input.command,
      ),
    })),
  );
  const invalid = inspections.find(
    ({ inspection }) => inspection.status === "invalid",
  );
  return invalid?.inspection.status === "invalid"
    ? {
        blocker: `${invalid.client.displayName ?? invalid.client.name}: ${invalid.inspection.remediation}`,
      }
    : inspections;
};

/** A client's registration settings: the shared ones, then its own. */
export const clientEnvironment = (
  input: {
    readonly providerEnvironment: SetupProviderEnvironment;
    readonly clientEnvironments?:
      | Readonly<Record<string, SetupProviderEnvironment>>
      | undefined;
  },
  client: string,
): SetupProviderEnvironment => ({
  ...input.providerEnvironment,
  ...input.clientEnvironments?.[client],
});

/** Selected clients whose registration setup writes, with the disclosed operation. */
const plannedClientWrites = (
  inspections: readonly {
    readonly client: SetupClient;
    readonly inspection: ClientConfigurationInspection;
  }[],
) =>
  inspections.flatMap(({ client, inspection }) =>
    client.format !== "unsupported" &&
    (inspection.status === "create" || inspection.status === "update")
      ? [
          {
            client,
            operation: inspection.status,
            ...(inspection.backupPath !== undefined
              ? { backupPath: inspection.backupPath }
              : {}),
          },
        ]
      : [],
  );

/** Describe every selected setup mutation before user approval. */
const setupPlan = (input: {
  readonly installSkill: boolean;
  readonly skillDestinations: readonly SkillDestination[];
  readonly clients: readonly {
    readonly client: SetupClient;
    readonly operation: "create" | "update";
    readonly backupPath?: string;
  }[];
  readonly providerEnvironment: SetupProviderEnvironment;
  readonly clientEnvironments?:
    | Readonly<Record<string, SetupProviderEnvironment>>
    | undefined;
  readonly command: readonly string[];
}): readonly SetupAction[] => [
  ...input.clients
    .filter(({ client }) => client.format !== "unsupported")
    .map(({ client, operation, backupPath }): SetupAction => ({
      id: `configure_client:${client.name}`,
      kind: "configure_client",
      label: client.displayName ?? client.name,
      target: client.configPath,
      detail: clientConfigurationDetail(
        client,
        input.command,
        clientEnvironment(input, client.name),
      ),
      external: false,
      operation,
      ...(backupPath === undefined ? {} : { backupPath }),
    })),
  ...(input.installSkill
    ? input.skillDestinations.map(({ client, path }): SetupAction => ({
        id: client === "shared" ? "install_skill" : `install_skill:${client}`,
        kind: "install_skill",
        label:
          client === "claude_code"
            ? "REA skill for Claude Code"
            : "REA reverse-engineering skill",
        target: path,
        detail:
          client === "claude_code"
            ? "Install or update the REA skill in Claude Code's personal skill directory."
            : "Install or update the bundled REA reverse-engineering skill and on-demand references.",
        external: false,
        operation: "install",
      }))
    : []),
];

const clientConfigurationDetail = (
  client: SetupClient,
  command: readonly string[],
  environment: SetupProviderEnvironment,
): string => {
  const entries = Object.entries(environment)
    .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
    .map(([name, value]) => `${name}=${value}`);
  const environmentDetail =
    entries.length === 0
      ? " No additional provider environment variables. Existing server environment overrides are retained."
      : ` Detected provider environment: ${entries.join(", ")}. Existing server environment overrides are retained; detected values replace matching keys.`;
  const persistence = registrationPersistenceDetail(client);
  return `Add the REA MCP registration for ${client.displayName ?? client.name}; preserve unrelated configuration. The backup path reflects the configuration inspected for this plan; if that file changes before execution, setup will select a recovery path for its current contents. Command: ${command.map((part) => JSON.stringify(part)).join(" ")}.${environmentDetail}${persistence === undefined ? "" : ` ${persistence}`}`;
};
