if (process.env.REA_TARGET_PATH !== undefined)
  throw new Error("The MCP doctor child inherited an eager target.");

process.stderr.write("fixture MCP startup exit\n");
process.exitCode = 23;
