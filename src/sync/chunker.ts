/**
 * Split file content into indexable chunks.
 * Splits by markdown headers first, then by paragraphs for large sections.
 */
export function chunkContent(
  content: string,
  maxChunkSize: number = 2000,
  minChunkSize: number = 20,
): string[] {
  // Split by markdown headers
  const sections = content.split(/(?=^#{1,3}\s)/m);
  const chunks: string[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length < minChunkSize) continue;

    if (trimmed.length <= maxChunkSize) {
      chunks.push(trimmed);
    } else {
      // Split large sections by paragraph breaks
      const paragraphs = trimmed.split(/\n\n+/);
      let current = "";

      for (const para of paragraphs) {
        if (current.length + para.length + 2 > maxChunkSize && current.length > 0) {
          if (current.trim().length >= minChunkSize) {
            chunks.push(current.trim());
          }
          current = para;
        } else {
          current += (current ? "\n\n" : "") + para;
        }
      }

      if (current.trim().length >= minChunkSize) {
        chunks.push(current.trim());
      }
    }
  }

  // Fallback: if no headers found, split by paragraphs
  if (chunks.length === 0 && content.trim().length >= minChunkSize) {
    const paragraphs = content.split(/\n\n+/);
    let current = "";

    for (const para of paragraphs) {
      if (current.length + para.length + 2 > maxChunkSize && current.length > 0) {
        if (current.trim().length >= minChunkSize) {
          chunks.push(current.trim());
        }
        current = para;
      } else {
        current += (current ? "\n\n" : "") + para;
      }
    }

    if (current.trim().length >= minChunkSize) {
      chunks.push(current.trim());
    }
  }

  return chunks;
}

/**
 * Classify a file by its path to determine source and category.
 */
export function classifyFile(
  filePath: string,
): { source: string; category: string } {
  const lower = filePath.toLowerCase();

  if (lower.includes("memory.md") || lower.includes("memory/"))
    return { source: "long_term_memory", category: "fact" };

  if (lower.endsWith(".ts") || lower.endsWith(".js") || lower.endsWith(".tsx") || lower.endsWith(".jsx"))
    return { source: "file_content", category: "code_pattern" };

  if (lower.endsWith(".py") || lower.endsWith(".rs") || lower.endsWith(".go"))
    return { source: "file_content", category: "code_pattern" };

  if (lower.endsWith(".md") || lower.endsWith(".txt"))
    return { source: "file_content", category: "fact" };

  if (lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml"))
    return { source: "file_content", category: "decision" };

  return { source: "file_content", category: "fact" };
}
