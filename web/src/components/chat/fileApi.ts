// Asks the service for a file named in a reply (src/net/chatFiles.ts). The page never guesses a path exists: a missing,
// outside or secret file answers 404 and the card then shows only the path.
import { api, url } from "../../ui/api";

export type FileText = { kind: "text"; path: string; total: number; from: number; to: number; text: string; truncated: boolean };
const base = (agent: string, path: string) => `v1/panel/agents/${encodeURIComponent(agent)}/file?path=${encodeURIComponent(path)}`;
export const loadFile = (agent: string, path: string, lines?: string) => api<FileText>(base(agent, path) + (lines ? `&lines=${lines}` : ""));
export const fileUrl = (agent: string, path: string) => url(base(agent, path));
