// The `jira` ui block (docs/CHAT-UI-BLOCKS.md, section "jira"): a draft of one or more tickets, the same list once Jira has
// them, or the list with the ones Jira refused. Pure: no DOM, no Jira call. The page only shows what the agent wrote and sends
// the owner's choice back as a message; the agent does the writing to Jira.

export type JiraKind = "bug" | "story" | "task" | "epic" | "subtask";
export type JiraPriority = "highest" | "high" | "medium" | "low" | "lowest";
export type JiraState = "draft" | "created" | "refused";
export type JiraLink = { rel: string; key: string; title?: string };
export type JiraTicket = {
  title: string; kind: JiraKind; key?: string; status?: string; priority?: JiraPriority; points?: number; description?: string;
  assignee?: string; labels: string[]; component?: string; links: JiraLink[]; /** Jira's reason when it refused this one */ error?: string; /** the retry button's label, with the fix the agent offers */ fix?: string;
};
export type JiraBlock = {
  type: "jira"; state: JiraState; project: string; board?: string; epic?: { key: string; title: string }; note?: string;
  tickets: JiraTicket[]; backlog?: string; /** an https address that opens the epic or board in Jira */ url?: string;
};

export const JIRA_KINDS: JiraKind[] = ["bug", "story", "task", "epic", "subtask"];
export const JIRA_PRIORITIES: JiraPriority[] = ["highest", "high", "medium", "low", "lowest"];
const MAX_TICKETS = 12, MAX_LABELS = 6, MAX_LINKS = 6;
const KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;

type Rec = Record<string, unknown>;
const rec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 200): string | undefined => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  return s ? (s.length > max ? s.slice(0, max) + "…" : s) : undefined;
};
const key = (v: unknown) => { const s = typeof v === "string" ? v.trim().toUpperCase() : ""; return KEY.test(s) ? s : undefined; };

function ticket(v: unknown): JiraTicket | null {
  if (!rec(v)) return null;
  const title = str(v.title, 200);
  if (!title) return null;
  const kind = JIRA_KINDS.includes(String(v.kind).toLowerCase() as JiraKind) ? (String(v.kind).toLowerCase() as JiraKind) : "task";
  const pr = String(v.priority ?? "").toLowerCase() as JiraPriority;
  const pts = typeof v.points === "number" && Number.isFinite(v.points) && v.points >= 0 && v.points <= 100 ? v.points : undefined;
  const labels = (Array.isArray(v.labels) ? v.labels : []).map((l) => str(l, 30)).filter((l): l is string => !!l).slice(0, MAX_LABELS);
  const links = (Array.isArray(v.links) ? v.links : []).flatMap((l): JiraLink[] => {
    if (!rec(l)) return [];
    const k = key(l.key), rel = str(l.rel, 30);
    return k && rel ? [{ rel, key: k, title: str(l.title, 80) }] : [];
  }).slice(0, MAX_LINKS);
  return {
    title, kind, key: key(v.key), status: str(v.status, 24), priority: JIRA_PRIORITIES.includes(pr) ? pr : undefined, points: pts,
    description: str(v.description, 2000), assignee: str(v.assignee, 40), labels, component: str(v.component, 40), links, error: str(v.error, 300), fix: str(v.fix, 60),
  };
}

/** One jira block, checked and trimmed; null when it is not valid. State is read from the data when not given: a ticket with
 *  an error makes it refused, all keyed makes it created, anything else is a draft. */
export function parseJira(v: unknown): JiraBlock | null {
  if (!rec(v) || v.type !== "jira" || !Array.isArray(v.tickets)) return null;
  const tickets = v.tickets.slice(0, MAX_TICKETS).map(ticket);
  if (!tickets.length || tickets.some((t) => !t)) return null;
  const ts = tickets as JiraTicket[];
  const project = str(v.project, 10);
  if (!project) return null;
  const given = String(v.state ?? "").toLowerCase();
  const state: JiraState = given === "draft" || given === "created" || given === "refused" ? given
    : ts.some((t) => t.error) ? "refused" : ts.every((t) => t.key) ? "created" : "draft";
  if (state !== "draft" && !ts.some((t) => t.key)) return null; // created or refused means Jira has at least one
  const e = rec(v.epic) ? { key: key(v.epic.key), title: str(v.epic.title, 120) } : null;
  return { type: "jira", state, project, board: str(v.board, 40), epic: e?.key && e.title ? { key: e.key, title: e.title } : undefined, note: str(v.note, 120), tickets: ts, backlog: str(v.backlog, 120), url: typeof v.url === "string" && /^https:\/\/[^\s]{1,300}$/.test(v.url.trim()) ? v.url.trim() : undefined };
}

export const pointsLabel = (n: number) => (n === 1 ? "1 point" : `${n} points`);
export const ticketCount = (n: number) => (n === 1 ? "1 ticket" : `${n} tickets`);
/** "3 stories, 6 points" for the draft footer. */
export function draftSummary(ts: JiraTicket[]): string {
  const stories = ts.length, pts = ts.reduce((a, t) => a + (t.points ?? 0), 0);
  return `${stories === 1 ? "1 story" : `${stories} stories`}${pts ? `, ${pointsLabel(pts)}` : ""}`;
}
/** The message Create sends as the owner: the picked drafts, by title. */
export const createMessage = (ts: JiraTicket[]) => `Create ${ticketCount(ts.length)} in Jira: ${ts.map((t) => t.title).join("; ")}`;
export const retryMessage = (t: JiraTicket) => `Retry in Jira: ${t.title}`;
export const leaveOutMessage = (t: JiraTicket) => `Leave out of Jira: ${t.title}`;
export const editMessage = (ts: JiraTicket[]) => `Change the Jira draft: ${ts.map((t) => t.title).join("; ")}`;
/** Counts for the created and refused header badges. */
export const madeCount = (ts: JiraTicket[]) => ts.filter((t) => t.key && !t.error).length;
