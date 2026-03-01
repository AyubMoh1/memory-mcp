export const log = {
  info: (...args: unknown[]) => console.error("[memory-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[memory-mcp:error]", ...args),
  debug: (...args: unknown[]) => {
    if (process.env.DEBUG) console.error("[memory-mcp:debug]", ...args);
  },
};
