import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ShepherdrTaskRow, ShepherdrTasks } from "../../shared/shepherdr-tasks.ts";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { useShepherdrTasks } from "../lib/shepherdrTasks.ts";
import { useT } from "../lib/i18n.ts";
import "./TasksSection.css";

const FOLD_KEY = "ovis.tasks.folded";

function readFolded(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(FOLD_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((kind): kind is string => typeof kind === "string") : [];
  } catch { return []; }
}

/** What the drawer button says of Shepherdr's own Needs you count, apart from the Inbox. */
export function tasksBadgeLabel(t: ReturnType<typeof useT>, count: number): string {
  return t("Tasks: {count} need you", { count });
}

/**
 * The Tasks section at the top of the sidebar and the drawer: Shepherdr's glance feed as it is, its groups in its order
 * with its counts, and nothing at all where this PC reads no Shepherdr. The grouped list with counts follows the Codex
 * app's task list; the groups, words and order are Shepherdr's own.
 */
export function TasksSection({ onOpen }: { onOpen(machineId: string, paneId: string): void }): ReactNode {
  const tasks = useShepherdrTasks();
  if (!tasks) return null;
  return <TasksList tasks={tasks} onOpen={onOpen} />;
}

export function TasksList({ tasks, onOpen }: { tasks: ShepherdrTasks; onOpen(machineId: string, paneId: string): void }): ReactNode {
  const t = useT();
  const baseId = useId();
  const [folded, setFolded] = useState(readFolded);
  const toggle = (kind: string) => {
    const next = folded.includes(kind) ? folded.filter((item) => item !== kind) : [...folded, kind];
    setFolded(next);
    try { window.localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch {}
  };
  return <section className={`tasks-sidebar${tasks.stale ? " is-stale" : ""}`} aria-label={t("Tasks")}>
    <div className="tasks-heading">
      <h2 className="tasks-title">{t("Tasks")}</h2>
      {tasks.stale && <span className="tasks-stale" role="status">{t("Reconnecting to Shepherdr…")}</span>}
    </div>
    <div className="tasks-groups">
      {tasks.groups.map((group) => {
        const rows = tasks.rows.filter((row) => row.group === group.kind);
        const more = group.count - rows.length;
        const isFolded = folded.includes(group.kind);
        const listId = `${baseId}-${group.kind}`;
        return <div key={group.kind} className={`tasks-group is-${group.kind}`}>
          <button type="button" className="tasks-group-toggle sidebar-section-label" aria-expanded={!isFolded} aria-controls={listId} onClick={() => toggle(group.kind)}>
            {isFolded ? <ChevronRight className="tasks-group-caret" aria-hidden="true" /> : <ChevronDown className="tasks-group-caret" aria-hidden="true" />}
            <span className="tasks-group-label">{group.label}</span>
            <span className="tasks-group-count">{group.count}</span>
          </button>
          <div id={listId} hidden={isFolded}>
            {rows.length > 0 && <ul className="tasks-list">
              {rows.map((row) => <li key={row.key}><TaskRow row={row} onOpen={onOpen} /></li>)}
            </ul>}
            {more > 0 && <p className="tasks-more">{t("+{count} more", { count: more })}</p>}
          </div>
        </div>;
      })}
    </div>
  </section>;
}

function TaskRow({ row, onOpen }: { row: ShepherdrTaskRow; onOpen(machineId: string, paneId: string): void }): ReactNode {
  const t = useT();
  const title = row.ref !== null ? row.name ?? row.body : row.title;
  const line = row.ref !== null ? row.line ?? row.body : row.body;
  const where = [row.space, line].filter((part): part is string => part !== null && part !== "").join(" · ");
  const facts = [row.progress !== null ? `${row.progress}%` : null, row.left !== null ? t("{left} left", { left: row.left }) : null].filter((part): part is string => part !== null);
  const note = row.open.kind === "other-machine" ? (row.open.machine ? t("On {machine}, can't be opened from this PC", { machine: row.open.machine }) : t("On another machine, can't be opened from this PC"))
    : row.open.kind === "no-terminal" ? t("No terminal running") : null;
  const body = <>
    <span className="task-row-top">
      {row.ref !== null && <span className="task-row-ref">{row.ref}</span>}
      <span className="task-row-title">{title}</span>
      {facts.length > 0 && <span className="task-row-facts">{facts.join(" · ")}</span>}
    </span>
    {where !== "" && <span className="task-row-line">{where}</span>}
    {note !== null && <span className="task-row-note">{note}</span>}
  </>;
  if (row.open.kind === "terminal") {
    const paneId = row.open.pane_id;
    return <button type="button" className={`task-row is-${row.group}`} onClick={() => onOpen(LOCAL_MACHINE, paneId)}>{body}</button>;
  }
  return <div className={`task-row is-${row.group} is-inert`}>{body}</div>;
}
