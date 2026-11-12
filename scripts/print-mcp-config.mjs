#!/usr/bin/env node
/**
 * Print a ready-to-paste MCP server config with absolute paths filled in.
 *
 * Usage:
 *   node scripts/print-mcp-config.mjs /path/to/binary
 *   node scripts/print-mcp-config.mjs /path/to/binary --ghidra-install-dir /path/to/ghidra
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "ghidra-install-dir": { type: "string" } },
});
const [targetPath] = positionals;
if (!targetPath || positionals.length !== 1) {
  process.stderr.write(
    "Usage: node scripts/print-mcp-config.mjs <target-path> [--ghidra-install-dir PATH]\n",
  );
  process.exit(1);
}

const installDir =
  values["ghidra-install-dir"] ?? process.env.GHIDRA_INSTALL_DIR;
const env = { REA_TARGET_PATH: resolve(targetPath) };
if (installDir) env.GHIDRA_INSTALL_DIR = resolve(installDir);
if (process.env.JAVA_HOME) env.JAVA_HOME = resolve(process.env.JAVA_HOME);

const config = {
  mcpServers: {
    rea: {
      command: "npx",
      args: [
        "-y",
        `${
          JSON.parse(
            await readFile(
              resolve(
                fileURLToPath(new URL("..", import.meta.url)),
                "package.json",
              ),
              "utf8",
            ),
          ).name
        }@latest`,
        "mcp",
      ],
      env,
    },
  },
};

process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
