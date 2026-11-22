/**
 * The Tasks section: Shepherdr's glance feed as this PC's Ovis server reads it (server/shepherdr-tasks.ts), with each
 * row's terminals on this PC. Ovis shows Shepherdr's own groups, order, counts and words and decides none of them
 * (docs/adr/0002-tasks-from-shepherdr-glance-feed.md).
 */

/** One of the feed's sections, in the feed's order, with Shepherdr's name and count (every item, even past the listed ones). */
export interface ShepherdrTaskGroup {
  kind: string;
  label: string;
  count: number;
}

/**
 * What tapping a row does.
 * - `terminal`: opens that pane on this PC (a task's agent, or an Assistant for its own card);
 * - `other-machine`: the task runs on another machine (`machine`, the feed's name for it);
 * - `no-terminal`: the task is on this PC, with no running terminal;
 * - `words`: nothing to open (an automation that didn't run, a machine's alert): the row only shows its words.
 */
export type ShepherdrRowOpen =
  | { kind: "terminal"; pane_id: string }
  | { kind: "other-machine"; machine: string | null }
  | { kind: "no-terminal" }
  | { kind: "words" };

/** A row as the feed lists it: its own words, and the buttons it offers (passed on as given). */
export interface ShepherdrTaskRow {
  /** the feed's key, stable while the thing lasts */
  key: string;
  /** the group (`ShepherdrTaskGroup.kind`) it is listed under */
  group: string;
  /** need | alert | task */
  type: string;
  /** the task's ref (`OVIS-5`), without a machine; null for a row of no task */
  ref: string | null;
  title: string;
  body: string;
  name: string | null;
  /** the space's name, for showing */
  space: string | null;
  /**
   * the space the row belongs to, as Shepherdr's place id: a Herdr app space id (an Ovis workspace id on this PC's
   * herdr-core), `<machine>/<id>` on another machine; null where none is known (a machine's own alert)
   */
  place: string | null;
  machine: string | null;
  line: string | null;
  progress: number | null;
  left: string | null;
  at: number | null;
  /** an Assistant's own card (no task) */
  assistant?: true;
  accept?: { task: string };
  answer?: { chat: string; question: string; choices: { i: number; label: string }[]; other?: boolean };
  reply?: { chat: string; to?: string };
  open: ShepherdrRowOpen;
  /** the task's terminals on this PC (its agent, helpers and reviewers): hidden elsewhere while this row is shown */
  terminals: string[];
}

export interface ShepherdrTasks {
  groups: ShepherdrTaskGroup[];
  /** in the feed's order */
  rows: ShepherdrTaskRow[];
  /** Shepherdr's Needs you count, for the drawer button */
  needs: number;
  /** the feed dropped: the last list, kept for a short while */
  stale: boolean;
  /** when Shepherdr built it (ms) */
  at: number;
}

/** The machine event; `tasks` absent: no Shepherdr on this PC (no section, nothing hidden). */
export interface ShepherdrTasksEvent {
  type: "shepherdr-tasks";
  tasks?: ShepherdrTasks;
}

/**
 * POST /api/shepherdr/action: acting on a row the Tasks section shows, by its `key`. The server builds Shepherdr's own
 * action from that row as the feed offers it (its `accept`, one of its `answer.choices`, or free words where
 * `answer.other`) and passes it to the Shepherdr service on its PC; the client never talks to Shepherdr.
 */
export type ShepherdrActionRequest =
  | { key: string; accept: true }
  | { key: string; choice: number }
  | { key: string; other: string };

/** The most free words an Other answer carries (Shepherdr keeps 4000). */
export const SHEPHERDR_OTHER_MAX = 4000;
