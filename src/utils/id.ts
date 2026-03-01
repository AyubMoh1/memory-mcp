import { randomBytes } from "node:crypto";

export function generateId(): string {
  const timestamp = Date.now();
  const random = randomBytes(4).toString("hex");
  return `mem_${timestamp}_${random}`;
}
