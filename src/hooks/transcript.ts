import { readFileSync } from "node:fs";

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface TranscriptEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  timestamp?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
}

export function parseTranscript(filePath: string): TranscriptMessage[] {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const messages: TranscriptMessage[] = [];

  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!entry.message?.role) continue;
    if (entry.type === "file-history-snapshot") continue;

    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;

    let content: string;

    if (typeof entry.message.content === "string") {
      content = entry.message.content;
    } else if (Array.isArray(entry.message.content)) {
      // Extract only text blocks, skip thinking/tool_use
      content = (entry.message.content as ContentBlock[])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n");
    } else {
      continue;
    }

    if (!content.trim()) continue;

    messages.push({
      role,
      content: content.trim(),
      timestamp: entry.timestamp || "",
    });
  }

  return messages;
}
