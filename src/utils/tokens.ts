/**
 * Estimate token count from text using chars/4 heuristic.
 * This is the same approach used in ocean's context-loader.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
