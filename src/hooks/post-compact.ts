#!/usr/bin/env node

const output = {
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext:
      "This session was compacted. Key memories from the previous conversation were automatically saved. Use memory_get_context or memory_search to retrieve relevant context from prior conversation.",
  },
};

process.stdout.write(JSON.stringify(output));
