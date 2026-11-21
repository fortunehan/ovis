/**
 * The Tasks section's source: Shepherdr's glance feed (Shepherdr docs/glance.md), read from the Shepherdr service on
 * this PC with its local token, and each row's terminals on this PC (docs/adr/0002-tasks-from-shepherdr-glance-feed.md).
 *
 * - The service writes its port and a fresh id in `service.json`; the token goes only to a service whose
 *   `/api/health` answers that id, so another program on the port never sees it.
 * - A health that says another machine serves Shepherdr, a refusal of the id, or a feed in another format is no
 *   Shepherdr: no section. A dropped stream keeps the last list for STALE_MS, marked stale.
 * - Loopback only (outbound.ts localFetch): never proxied, so proxy-only mode leaves it as it is.
 * - Shepherdr's task lists are read for identity only (which terminal is which task), never for state.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SHEPHERDR_OTHER_MAX, type ShepherdrActionRequest, type ShepherdrRowOpen, type ShepherdrTaskGroup, type ShepherdrTaskRow, type ShepherdrTasks } from "../shared/shepherdr-tasks.ts";
import { badRequest, conflictResponse, isJsonObject, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { localFetch } from "./outbound.ts";

export const GLANCE_FORMAT = 1;
/** how long a dropped feed's last list stays */
export const STALE_MS = 120_000;
/** a stream that says nothing this long is gone (the feed pings every 240 s) */
export const SILENT_MS = 300_000;
/** how often a stream that stays open asks health again (Serve from can move Shepherdr to another machine) */
export const RECHECK_MS = 60_000;
const RETRY_MS = [2_000, 5_000, 10_000, 30_000] as const;
const ASK_TIMEOUT_MS = 5_000;
/** an action's answer: an Accept only starts herdr-task's merge (it finishes in the background) */
const ACTION_TIMEOUT_MS = 30_000;
/** the most of Shepherdr's refusal shown on a row */
const REFUSAL_MAX = 300;

export const TASK_LABEL = "herdr.task";
export const ROLE_LABEL = "herdr.role";
export const ASSISTANT_SPACE_LABEL = "herdr.coordinator.space";
export const CHAT_LABEL = "herdr.chat";

export interface ShepherdrPaths {
  serviceFile: string;
  tokenFile: string;
  tasksDir: string;
}

const absolute = (value: string | undefined): string | null => (value && value.startsWith("/") ? value.replace(/\/+$/, "") : null);

/**
 * Shepherdr's own paths (its core/paths.js): its `shepherdr` folders once this machine's data moved there
 * (data/LAYOUT says 2 or more, no rollback mark), else the old ones under ~/.herdr.
 */
export function shepherdrPaths(home = homedir(), env: Record<string, string | undefined> = process.env): ShepherdrPaths {
  const one = absolute(env["SHEPHERDR_HOME"]);
  const root = (variable: string, fallback: string) => `${absolute(env[variable]) ?? join(home, fallback)}/shepherdr`;
  const data = one ? join(one, "data") : root("XDG_DATA_HOME", ".local/share");
  const state = one ? join(one, "state") : root("XDG_STATE_HOME", ".local/state");
  let layout = "";
  try { layout = readFileSync(join(data, "LAYOUT"), "utf8"); } catch {}
  let rolledBack = false;
  try { readFileSync(join(home, ".herdr", ".layout-rollback")); rolledBack = true; } catch (error) { rolledBack = (error as NodeJS.ErrnoException).code === "EISDIR"; }
  const migrated = !rolledBack && Number(layout.trim().split(/\s+/)[0]) >= 2;
  const service = migrated ? join(state, "service") : join(home, ".herdr", "shepherdr");
  return { serviceFile: join(service, "service.json"), tokenFile: join(service, "token"), tasksDir: migrated ? join(data, "tasks") : join(home, ".herdr", "tasks") };
}

/** herdr-task's prefix for a list that names none (Shepherdr core/tasks.js autoPrefix). */
export function autoPrefix(folder: string): string {
  const name = folder.split("/").filter(Boolean).pop() ?? "";
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^A-Za-z]+/).filter(Boolean);
  let prefix = words.length > 1 ? words.map((word) => word[0]).join("").slice(0, 5) : (words[0] ?? "").slice(0, 4);
  if (prefix.length < 2) prefix = words.join("").length >= 2 ? words.join("").slice(0, 2) : "TASK";
  return prefix.toUpperCase();
}

/** A task by its ref (`OVIS-5`): the label its terminals carry (`<list slug>#<id>`) and the agents herdr-task started for it. */
export interface TaskIdentity {
  label: string;
  agents: string[];
}

/** This PC's task lists: each task's identity by its ref. A list that won't parse is skipped. */
export function readTaskIdentities(dir: string): Map<string, TaskIdentity> {
  const out = new Map<string, TaskIdentity>();
  let names: string[] = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith(".json")); } catch { return out; }
  for (const name of names) {
    let list: unknown;
    try { list = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { continue; }
    if (!isRecord(list) || !Array.isArray(list["tasks"])) continue;
    const slug = name.slice(0, -".json".length);
    const prefix = typeof list["prefix"] === "string" && list["prefix"] ? list["prefix"] : autoPrefix(typeof list["folder"] === "string" ? list["folder"] : "");
    for (const task of list["tasks"]) {
      if (!isRecord(task) || typeof task["id"] !== "number") continue;
      const agents = Array.isArray(task["agents"]) ? task["agents"].flatMap((agent) => isRecord(agent) && typeof agent["address"] === "string" && !agent["ended"] ? [agent["address"]] : []) : [];
      out.set(`${prefix}-${task["id"]}`, { label: `${slug}#${task["id"]}`, agents });
    }
  }
  return out;
}

/** A terminal on this PC's core, as much as the mapping needs. */
export interface TerminalFacts {
  address: string;
  state: string;
  labels?: Record<string, string> | undefined;
  parent?: string | null | undefined;
}

type GlanceItem = Record<string, unknown>;
export interface GlanceDoc {
  format: number;
  at: number;
  groups: ShepherdrTaskGroup[];
  items: GlanceItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The feed's doc when it is one this Ovis reads (format 1), else null. */
export function readGlance(value: unknown): GlanceDoc | null {
  if (!isRecord(value) || value["format"] !== GLANCE_FORMAT || !Array.isArray(value["groups"]) || !Array.isArray(value["items"])) return null;
  const groups: ShepherdrTaskGroup[] = [];
  for (const group of value["groups"]) {
    if (!isRecord(group) || typeof group["kind"] !== "string" || typeof group["label"] !== "string" || typeof group["count"] !== "number") return null;
    groups.push({ kind: group["kind"], label: group["label"], count: group["count"] });
  }
  return { format: GLANCE_FORMAT, at: typeof value["at"] === "number" ? value["at"] : 0, groups, items: value["items"].filter(isRecord) };
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The place a row's link names (`./?place=sp42&task=…`). */
function placeOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const query = /^\.\/\?([^#]*)/.exec(url);
  return query ? new URLSearchParams(query[1]).get("place") : null;
}

/**
 * The Tasks section's list: the feed's groups and rows, each row with what tapping it opens and its task's terminals on
 * this PC. A task id with a machine (`m3:VIBE-10`), or a place on one (`m3/sp4`), is another machine's: Shepherdr's own
 * ids say so, as its own screens do.
 */
export function tasksOf(doc: GlanceDoc, stale: boolean, terminals: readonly TerminalFacts[], identities: ReadonlyMap<string, TaskIdentity>): ShepherdrTasks {
  const live = terminals.filter((terminal) => terminal.state === "live" && !terminal.address.includes("/"));
  const children = new Map<string, TerminalFacts[]>();
  for (const terminal of live) if (terminal.parent) children.set(terminal.parent, [...children.get(terminal.parent) ?? [], terminal]);
  const rows: ShepherdrTaskRow[] = doc.items.map((item) => {
    const task = text(item["task"]);
    const id = task?.replace(/#.*$/, "") ?? null;
    const remote = id !== null && id.includes(":");
    const ref = id === null ? null : id.slice(id.lastIndexOf(":") + 1);
    const place = placeOf(item["url"]);
    const key = text(item["key"]) ?? "";
    const assistant = task === null && item["type"] === "need" && !key.startsWith("auto:");
    const chat = isRecord(item["answer"]) ? text(item["answer"]["chat"]) : isRecord(item["reply"]) ? text(item["reply"]["chat"]) : null;
    let open: ShepherdrRowOpen;
    let own: string[] = [];
    if (remote || (task === null && place?.includes("/"))) {
      open = { kind: "other-machine", machine: text(item["machine"]) };
    } else if (ref !== null) {
      own = taskTerminals(identities.get(ref), live, children);
      const agent = mainAgent(own, live);
      open = agent ? { kind: "terminal", pane_id: agent } : { kind: "no-terminal" };
    } else if (assistant) {
      const found = live.find((terminal) => terminal.labels?.[ROLE_LABEL] === "coordinator" && ((chat !== null && terminal.labels?.[CHAT_LABEL] === chat) || (place !== null && terminal.labels?.[ASSISTANT_SPACE_LABEL] === place)));
      open = found ? { kind: "terminal", pane_id: found.address } : { kind: "no-terminal" };
    } else {
      open = { kind: "words" };
    }
    const row: ShepherdrTaskRow = {
      key, group: text(item["kind"]) ?? "", type: text(item["type"]) ?? "", ref,
      title: text(item["title"]) ?? "", body: text(item["body"]) ?? "",
      name: text(item["name"]), space: text(item["space"]), machine: text(item["machine"]), line: text(item["line"]),
      progress: number(item["progress"]), left: text(item["left"]), at: number(item["at"]),
      open, terminals: own,
    };
    if (assistant) row.assistant = true;
    if (isRecord(item["accept"]) && typeof item["accept"]["task"] === "string") row.accept = { task: item["accept"]["task"] };
    if (isRecord(item["answer"])) {
      const answer = item["answer"];
      const choices = Array.isArray(answer["choices"]) ? answer["choices"].flatMap((choice) => isRecord(choice) && typeof choice["i"] === "number" && typeof choice["label"] === "string" ? [{ i: choice["i"], label: choice["label"] }] : []) : [];
      if (typeof answer["chat"] === "string" && typeof answer["question"] === "string") row.answer = { chat: answer["chat"], question: answer["question"], choices, ...(answer["other"] === true ? { other: true } : {}) };
    }
    if (isRecord(item["reply"]) && typeof item["reply"]["chat"] === "string") row.reply = { chat: item["reply"]["chat"], ...(typeof item["reply"]["to"] === "string" ? { to: item["reply"]["to"] } : {}) };
    return row;
  });
  const needs = doc.groups.find((group) => group.kind === "needs")?.count ?? 0;
  return { groups: doc.groups, rows, needs, stale, at: doc.at };
}

/** A task's live terminals here: those labeled with it or started for it, and every terminal they started (helpers, reviewers). */
function taskTerminals(identity: TaskIdentity | undefined, live: readonly TerminalFacts[], children: ReadonlyMap<string, TerminalFacts[]>): string[] {
  if (!identity) return [];
  const found = new Set(live.filter((terminal) => terminal.labels?.[TASK_LABEL] === identity.label || identity.agents.includes(terminal.address)).map((terminal) => terminal.address));
  for (const address of [...found]) for (const child of descendants(address, children)) found.add(child);
  return live.map((terminal) => terminal.address).filter((address) => found.has(address));
}

function descendants(address: string, children: ReadonlyMap<string, TerminalFacts[]>, seen = new Set<string>()): string[] {
  for (const child of children.get(address) ?? []) {
    if (seen.has(child.address)) continue;
    seen.add(child.address);
    descendants(child.address, children, seen);
  }
  return [...seen];
}

/** The task's own agent: not a helper or reviewer, and not started by another of its terminals; the newest of several. */
function mainAgent(own: readonly string[], live: readonly TerminalFacts[]): string | null {
  const mine = live.filter((terminal) => own.includes(terminal.address));
  const agents = mine.filter((terminal) => {
    const role = terminal.labels?.[ROLE_LABEL];
    return role !== "reviewer" && role !== "helper" && !(terminal.parent && own.includes(terminal.parent));
  });
  return (agents.at(-1) ?? mine[0])?.address ?? null;
}

/** Splits an event stream's text into its events (`event:` and `data:` lines), keeping an unfinished one for later. */
export function sseEvents(buffer: string): { events: { event: string; data: string }[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  const events = parts.flatMap((part) => {
    let event = "message";
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return data.length > 0 ? [{ event, data: data.join("\n") }] : [];
  });
  return { events, rest };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What Shepherdr made of an action: done, refused in its own words, or no Shepherdr to ask. */
export type ShepherdrActOutcome = { ok: true } | { ok: false; reason: "refused"; message: string } | { ok: false; reason: "absent" | "silent" };

function refusalWords(value: unknown, status: number): string {
  const words = typeof value === "string" ? value.trim() : "";
  return words === "" ? `Shepherdr refused it (${status}).` : words.slice(0, REFUSAL_MAX);
}

/**
 * Shepherdr's action for a row the Tasks section shows, as the feed documents it (docs/glance.md, "Acting on an item"):
 * only what that row offers, so a page can't send Shepherdr anything else. Null: the row offers no such thing.
 */
export function actionFor(row: ShepherdrTaskRow, request: ShepherdrActionRequest): Record<string, unknown> | null {
  if ("accept" in request) return row.accept ? { type: "accept", task: row.accept.task } : null;
  const answer = row.answer;
  if (!answer) return null;
  if ("choice" in request) return answer.choices.some((choice) => choice.i === request.choice) ? { type: "answer", chat: answer.chat, question: answer.question, choice: request.choice, fromAlert: true } : null;
  const words = request.other.trim();
  return answer.other && words !== "" ? { type: "answer", chat: answer.chat, question: answer.question, other: words, fromAlert: true } : null;
}

/** The body of POST /api/shepherdr/action, or null when it is none of its shapes. */
export function readActionRequest(value: Record<string, unknown>): ShepherdrActionRequest | null {
  const key = value["key"];
  if (typeof key !== "string" || key === "" || key.length > 400) return null;
  const given = ["accept", "choice", "other"].filter((field) => field in value);
  if (given.length !== 1) return null;
  if (value["accept"] === true) return { key, accept: true };
  if (Number.isInteger(value["choice"]) && (value["choice"] as number) >= 0) return { key, choice: value["choice"] as number };
  if (typeof value["other"] === "string" && value["other"].length <= SHEPHERDR_OTHER_MAX) return { key, other: value["other"] };
  return null;
}

/** Why the feed is not read now: `absent` (no Shepherdr here: drop the list at once) or `dropped` (keep it a while). */
type Outcome = "absent" | "dropped";

export interface ShepherdrFeedOptions {
  paths?: ShepherdrPaths | (() => ShepherdrPaths);
  fetch?: Fetch;
  /** told each doc (null: none now) and whether it is a dropped feed's last one */
  onDoc: (doc: GlanceDoc | null, stale: boolean) => void;
  staleMs?: number;
  retryMs?: readonly number[];
  silentMs?: number;
  recheckMs?: number;
}

/** Follows the feed: connects, reconnects calmly, keeps a dropped feed's last doc a while. */
export class ShepherdrFeed {
  private stopped = false;
  private doc: GlanceDoc | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private failures = 0;
  private readonly fetch: Fetch;

  constructor(private readonly options: ShepherdrFeedOptions) {
    this.fetch = options.fetch ?? ((input, init) => localFetch(input, init));
  }

  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    if (this.staleTimer) clearTimeout(this.staleTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  /**
   * One of Shepherdr's actions (POST /api/action), sent as the feed is read: only to the service its file names and whose
   * health answers that id, over loopback with the token and no Origin. Shepherdr's own words when it refuses.
   */
  async act(body: Record<string, unknown>): Promise<ShepherdrActOutcome> {
    const signal = AbortSignal.timeout(ACTION_TIMEOUT_MS);
    const found = await this.service(signal).catch((): Outcome => "dropped");
    if (typeof found === "string") return { ok: false, reason: "absent" };
    let answer: Response;
    let words: string;
    try {
      answer = await this.fetch(`${found.base}/api/action`, { method: "POST", headers: { authorization: `Bearer ${found.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal });
      words = await answer.text();
    } catch { return { ok: false, reason: "silent" }; }
    let parsed: unknown = null;
    try { parsed = JSON.parse(words); } catch {}
    if (!answer.ok) return { ok: false, reason: "refused", message: refusalWords(isRecord(parsed) ? parsed["error"] : words, answer.status) };
    if (isRecord(parsed) && parsed["ok"] === false) return { ok: false, reason: "refused", message: refusalWords(parsed["error"], answer.status) };
    return { ok: true };
  }

  private paths(): ShepherdrPaths {
    const given = this.options.paths;
    return typeof given === "function" ? given() : given ?? shepherdrPaths();
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    const outcome = await this.follow().catch((): Outcome => "dropped");
    if (this.stopped) return;
    if (outcome === "absent") this.drop();
    else this.markStale();
    const retry = this.options.retryMs ?? RETRY_MS;
    const wait = retry[Math.min(this.failures, retry.length - 1)] ?? 30_000;
    this.failures++;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.run(); }, wait);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  /** The service on this PC, when it is the one its service file names and it serves Shepherdr here. */
  private async service(signal: AbortSignal): Promise<{ base: string; token: string } | Outcome> {
    let file: unknown;
    const paths = this.paths();
    try { file = JSON.parse(readFileSync(paths.serviceFile, "utf8")); } catch { return "absent"; }
    if (!isRecord(file) || typeof file["id"] !== "string" || !file["id"] || !Number.isInteger(file["port"])) return "absent";
    const base = `http://127.0.0.1:${file["port"] as number}`;
    let health: unknown;
    try {
      const answer = await this.fetch(`${base}/api/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(ASK_TIMEOUT_MS)]) });
      if (!answer.ok) return "dropped";
      health = await answer.json();
    } catch { return "dropped"; }
    if (!isRecord(health) || health["app"] !== "shepherdr" || health["id"] !== file["id"] || health["serving"] !== true) return "absent";
    let token: string;
    try { token = readFileSync(paths.tokenFile, "utf8").trim(); } catch { return "absent"; }
    return token ? { base, token } : "absent";
  }

  private async follow(): Promise<Outcome> {
    const abort = new AbortController();
    this.abort = abort;
    const found = await this.service(abort.signal);
    if (typeof found === "string") return found;
    const answer = await this.fetch(`${found.base}/api/glance?stream=1`, { headers: { authorization: `Bearer ${found.token}`, accept: "text/event-stream" }, signal: abort.signal });
    if (answer.status === 401 || answer.status === 403 || answer.status === 404) return "absent";
    if (!answer.ok || !answer.body) return "dropped";
    let outcome: Outcome = "dropped";
    let heard = Date.now();
    const silentMs = this.options.silentMs ?? SILENT_MS;
    const watch = setInterval(async () => {
      if (Date.now() - heard > silentMs) { abort.abort(); return; }
      const still = await this.service(abort.signal).catch((): Outcome => "dropped");
      if (typeof still === "string" || still.token !== found.token || still.base !== found.base) { outcome = typeof still === "string" ? still : "absent"; abort.abort(); }
    }, Math.min(this.options.recheckMs ?? RECHECK_MS, silentMs));
    (watch as { unref?: () => void }).unref?.();
    const reader = answer.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        heard = Date.now();
        const { events, rest } = sseEvents(buffer + value);
        buffer = rest;
        for (const event of events) {
          if (event.event !== "glance") continue;
          let parsed: unknown;
          try { parsed = JSON.parse(event.data); } catch { continue; }
          const doc = readGlance(parsed);
          if (!doc) { outcome = "absent"; abort.abort(); return outcome; }
          this.failures = 0;
          this.show(doc);
        }
      }
    } catch {
      // aborted or cut: `outcome` says which
    } finally {
      clearInterval(watch);
      reader.cancel().catch(() => {});
    }
    return outcome;
  }

  private show(doc: GlanceDoc): void {
    if (this.staleTimer) { clearTimeout(this.staleTimer); this.staleTimer = null; }
    this.doc = doc;
    this.options.onDoc(doc, false);
  }

  private markStale(): void {
    if (!this.doc || this.staleTimer) return;
    this.options.onDoc(this.doc, true);
    this.staleTimer = setTimeout(() => { this.staleTimer = null; this.drop(); }, this.options.staleMs ?? STALE_MS);
    (this.staleTimer as { unref?: () => void }).unref?.();
  }

  private drop(): void {
    if (this.staleTimer) { clearTimeout(this.staleTimer); this.staleTimer = null; }
    if (!this.doc) return;
    this.doc = null;
    this.options.onDoc(null, false);
  }
}

export const SHEPHERDR_ACTION_PATH = "/api/shepherdr/action";

/**
 * POST /api/shepherdr/action { key, accept | choice | other } -> { ok: true }. Refusals: 400 invalid_body, 409 card_gone
 * (the row isn't listed now), 409 not_offered (it offers no such button), 409 shepherdr_refused (Shepherdr's own words),
 * 503 no_shepherdr, 504 shepherdr_silent. No retry: the live feed then updates the row.
 */
export async function handleShepherdrActionRequest(request: Request, service: Pick<ShepherdrTasksService, "act"> | null): Promise<Response> {
  setRequestRoute(SHEPHERDR_ACTION_PATH);
  if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "Use POST" } }, 405);
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const action = isJsonObject(body) ? readActionRequest(body) : null;
  if (!action) return badRequest("invalid_body", "Send { key, accept: true }, { key, choice } or { key, other }");
  const outcome = service ? await service.act(action) : { ok: false as const, reason: "absent" as const };
  if (outcome === "gone") return conflictResponse("card_gone", "This card isn't listed any more.");
  if (outcome === "not-offered") return conflictResponse("not_offered", "This card doesn't offer that.");
  if (outcome.ok) return jsonResponse({ ok: true });
  if (outcome.reason === "refused") return conflictResponse("shepherdr_refused", outcome.message);
  if (outcome.reason === "silent") return jsonResponse({ error: { code: "shepherdr_silent", message: "Shepherdr didn't answer." } }, 504);
  return jsonResponse({ error: { code: "no_shepherdr", message: "Shepherdr isn't running on this PC." } }, 503);
}

/** The Tasks section's document where this PC reads no Shepherdr: none, ever. */
export const NO_SHEPHERDR = { get: (): ShepherdrTasks | null => null, subscribe: (): (() => void) => () => {} };

export interface ShepherdrTasksOptions {
  /** this PC's live terminals (herdr-core's terminal.list) */
  terminals: () => Promise<readonly TerminalFacts[]>;
  paths?: () => ShepherdrPaths;
  fetch?: Fetch;
  /** how often the terminals are read again while a list is shown, besides each change told by `terminalsChanged` */
  refreshMs?: number;
}

/** The Tasks section's document for the machine events: get() now, subscribe() to each change. */
export class ShepherdrTasksService {
  private tasks: ShepherdrTasks | null = null;
  private told = "";
  private doc: GlanceDoc | null = null;
  private stale = false;
  private readonly listeners = new Set<(tasks: ShepherdrTasks | null) => void>();
  private readonly feed: ShepherdrFeed;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  private building: Promise<void> | null = null;
  private again = false;

  constructor(private readonly options: ShepherdrTasksOptions) {
    const paths = options.paths ?? (() => shepherdrPaths());
    this.paths = paths;
    this.feed = new ShepherdrFeed({ paths, ...(options.fetch ? { fetch: options.fetch } : {}), onDoc: (doc, stale) => { this.doc = doc; this.stale = stale; void this.build(); } });
  }

  private readonly paths: () => ShepherdrPaths;

  start(): void {
    this.feed.start();
    this.refreshTimer = setInterval(() => { if (this.doc) void this.build(); }, this.options.refreshMs ?? 15_000);
    (this.refreshTimer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.feed.stop();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.listeners.clear();
  }

  get(): ShepherdrTasks | null {
    return this.tasks;
  }

  subscribe(listener: (tasks: ShepherdrTasks | null) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A row's action (POST /api/shepherdr/action), on a row this list shows now. */
  async act(request: ShepherdrActionRequest): Promise<ShepherdrActOutcome | "gone" | "not-offered"> {
    const row = this.tasks?.rows.find((candidate) => candidate.key === request.key);
    if (!row) return "gone";
    const body = actionFor(row, request);
    if (!body) return "not-offered";
    return this.feed.act(body);
  }

  /** a terminal started, ended or moved: the rows' terminals are read again soon */
  terminalsChanged(): void {
    if (!this.doc || this.soonTimer) return;
    this.soonTimer = setTimeout(() => { this.soonTimer = null; void this.build(); }, 300);
    (this.soonTimer as { unref?: () => void }).unref?.();
  }

  private build(): Promise<void> {
    if (this.building) { this.again = true; return this.building; }
    this.building = (async () => {
      do {
        this.again = false;
        const doc = this.doc;
        let next: ShepherdrTasks | null = null;
        if (doc) {
          const terminals = await this.options.terminals().catch(() => [] as const);
          next = tasksOf(doc, this.stale, terminals, readTaskIdentities(this.paths().tasksDir));
        }
        this.set(next);
      } while (this.again);
    })().finally(() => { this.building = null; });
    return this.building;
  }

  private set(next: ShepherdrTasks | null): void {
    const encoded = JSON.stringify(next);
    if (encoded === this.told) return;
    this.told = encoded;
    this.tasks = next;
    for (const listener of [...this.listeners]) listener(next);
  }
}
