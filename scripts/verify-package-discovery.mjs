const REQUIRED_HELP_COMMANDS = [
  "setup",
  "update",
  "inspect-artifact",
  "extract-artifact",
  "import-reference-source",
  "list-browser-targets",
  "inspect-web-page",
  "analyze-javascript-application",
  "compare",
];

const REQUIRED_LLM_TOPICS = [
  "decompile",
  "function",
  "search",
  "inspect",
  "xrefs",
  "trace",
  "capabilities",
  "providers",
  "inspect-artifact",
  "list-browser-targets",
  "inspect-web-page",
  "analyze-javascript-application",
];

/** Validate --help, --llms, and doctor output and determine host setup support. */
export async function verifyPackageDiscovery({ commands, cli, environment }) {
  const help = await commands.run(cli, ["--help"], environment);
  const llms = await commands.run(cli, ["--llms"], environment);
  const doctorExecution = await commands.runWithStatus(
    cli,
    ["doctor", "--json"],
    environment,
  );
  const doctor = JSON.parse(doctorExecution.stdout);
  const supportedSetupHost =
    doctor.checks?.find(({ name }) => name === "node")?.ok === true;
  const missingHelp = REQUIRED_HELP_COMMANDS.filter(
    (command) => !help.includes(command),
  );
  const missingLlms = REQUIRED_LLM_TOPICS.filter(
    (topic) => !llms.includes(topic),
  );
  if (
    missingHelp.length !== 0 ||
    missingLlms.length !== 0 ||
    typeof doctor.healthy !== "boolean" ||
    doctorExecution.status !== (doctor.healthy ? 0 : 1) ||
    !doctor.providerInspections?.some(({ id }) => id === "ghidra")
  )
    throw new Error(
      `packaged CLI discovery or doctor failed: ${JSON.stringify({ helpSetup: help.includes("setup"), llmsDecompile: llms.includes("decompile"), doctor })}`,
    );
  return { supportedSetupHost };
}
