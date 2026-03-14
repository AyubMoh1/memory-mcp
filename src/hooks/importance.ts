/**
 * Content-aware importance scoring for messages.
 * Analyzes message content to assign higher importance to
 * decisions, errors, preferences, and key facts.
 */

interface ImportanceSignal {
  pattern: RegExp;
  boost: number;
}

// Signals that indicate high-value content
const HIGH_VALUE_SIGNALS: ImportanceSignal[] = [
  // Decisions and conclusions
  { pattern: /\b(decided|decision|we('ll| will) go with|let's go with|chosen|picked|settled on)\b/i, boost: 0.25 },
  { pattern: /\b(the fix|root cause|the problem (is|was)|the issue (is|was)|bug|broken|regression)\b/i, boost: 0.20 },
  { pattern: /\b(error|exception|failed|failure|crash|traceback|stack trace)\b/i, boost: 0.20 },
  // Architecture and design
  { pattern: /\b(architecture|design|pattern|refactor|migration|schema|database)\b/i, boost: 0.15 },
  // Configuration and setup
  { pattern: /\b(configured|config|setup|installed|environment|deploy|CI\/CD|pipeline)\b/i, boost: 0.10 },
  // Preferences and corrections
  { pattern: /\b(don't|do not|never|always|prefer|instead of|rather than|stop doing)\b/i, boost: 0.15 },
  // Important outcomes
  { pattern: /\b(committed|pushed|merged|deployed|released|shipped)\b/i, boost: 0.10 },
  // Code changes with specifics
  { pattern: /\b(function|class|method|endpoint|api|route|hook|component)\b/i, boost: 0.05 },
];

// Signals that indicate low-value content
const LOW_VALUE_SIGNALS: ImportanceSignal[] = [
  // Acknowledgments
  { pattern: /^(ok|okay|yes|no|sure|thanks|got it|done|yep|nope|right|k)\s*[.!]?$/i, boost: -0.15 },
  // Interrupted requests
  { pattern: /\[Request interrupted by user\]/i, boost: -0.20 },
  // Very short content (< 20 chars)
  { pattern: /^.{1,20}$/s, boost: -0.10 },
];

/**
 * Score the importance of a message based on its content.
 * Returns a value between 0.2 and 0.9.
 */
export function scoreMessageImportance(content: string, role: "user" | "assistant"): number {
  const baseImportance = role === "assistant" ? 0.4 : 0.35;
  let totalBoost = 0;

  // Check high-value signals
  for (const signal of HIGH_VALUE_SIGNALS) {
    if (signal.pattern.test(content)) {
      totalBoost += signal.boost;
    }
  }

  // Check low-value signals
  for (const signal of LOW_VALUE_SIGNALS) {
    if (signal.pattern.test(content)) {
      totalBoost += signal.boost; // boost is negative
    }
  }

  // Longer, substantive content gets a small boost
  const wordCount = content.split(/\s+/).length;
  if (wordCount > 100) totalBoost += 0.10;
  else if (wordCount > 50) totalBoost += 0.05;

  // Content with code blocks gets a boost
  if (content.includes("```") || content.includes("    ")) {
    totalBoost += 0.05;
  }

  return Math.max(0.2, Math.min(0.9, baseImportance + totalBoost));
}

/**
 * Infer the best category for a message based on content signals.
 */
export function inferCategory(content: string): "conversation" | "decision" | "error" | "preference" | "fact" | "code_pattern" {
  if (/\b(error|exception|failed|failure|crash|traceback|stack trace|bug|broken)\b/i.test(content)) {
    return "error";
  }
  if (/\b(decided|decision|we('ll| will) go with|let's go with|chosen|settled on)\b/i.test(content)) {
    return "decision";
  }
  if (/\b(don't|do not|never|always|prefer|instead of|rather than|stop doing)\b/i.test(content)) {
    return "preference";
  }
  if (/```[\s\S]*```/.test(content) || /\b(function|class|interface|type|const|let|var)\s+\w+/i.test(content)) {
    return "code_pattern";
  }
  return "conversation";
}
