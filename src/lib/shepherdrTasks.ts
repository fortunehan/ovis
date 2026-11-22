import { useMemo, useSyncExternalStore } from "react";
import type { ShepherdrTaskGroup, ShepherdrTaskRow, ShepherdrTasks } from "../../shared/shepherdr-tasks.ts";
import { HC_OTHER_WORKSPACE_ID, LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";

/**
 * The Tasks section's list, as this server reads Shepherdr's glance feed on its PC (server/shepherdr-tasks.ts) and
 * tells it on the machine events. Null: no Shepherdr there, so no section and nothing hidden.
 */
let current: ShepherdrTasks | null = null;
const listeners = new Set<() => void>();

export function currentShepherdrTasks(): ShepherdrTasks | null {
  return current;
}

export function setShepherdrTasks(next: ShepherdrTasks | null): void {
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeShepherdrTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useShepherdrTasks(): ShepherdrTasks | null {
  return useSyncExternalStore(subscribeShepherdrTasks, currentShepherdrTasks, () => null);
}

/** The PCs the workspace list, the agent list and the Inbox draw (withoutTaskTerminals), and Shepherdr's Needs you count for the drawer button. */
export function useTaskListedMachines<T extends Pick<Machine, "id" | "snapshot">>(machines: readonly T[]): { machines: T[]; needs: number } {
  const tasks = useShepherdrTasks();
  const listed = useMemo(() => withoutTaskTerminals(machines, tasks), [machines, tasks]);
  return { machines: listed, needs: tasks?.needs ?? 0 };
}

/** The terminals of the rows the Tasks section shows (a task's agent, helpers and reviewers): reached only from there. */
export function taskTerminals(tasks: ShepherdrTasks | null): ReadonlySet<string> {
  return new Set(tasks?.rows.flatMap((row) => row.terminals) ?? []);
}

/**
 * The PCs as the workspace list, the agent list and the Inbox draw them: this server's own PC without the terminals of
 * the rows the Tasks section shows, and a tab or workspace left with none of its panes goes with them. Every other
 * PC, and every PC while there is no list, is unchanged (the same objects).
 */
export function withoutTaskTerminals<T extends Pick<Machine, "id" | "snapshot">>(machines: readonly T[], tasks: ShepherdrTasks | null): T[] {
  const hidden = taskTerminals(tasks);
  if (hidden.size === 0) return machines as T[];
  return machines.map((machine) => {
    const snapshot = machine.snapshot;
    if (machine.id !== LOCAL_MACHINE || !snapshot) return machine;
    const gone = (pane: { pane_id: string; terminal_id?: string | null }) => hidden.has(pane.pane_id) || (pane.terminal_id != null && hidden.has(pane.terminal_id));
    if (!snapshot.panes.some(gone)) return machine;
    const panes = snapshot.panes.filter((pane) => !gone(pane));
    const emptied = new Set(snapshot.tabs.filter((tab) => snapshot.panes.some((pane) => pane.tab_id === tab.tab_id && gone(pane)) && !panes.some((pane) => pane.tab_id === tab.tab_id)).map((tab) => tab.tab_id));
    const tabs = snapshot.tabs.filter((tab) => !emptied.has(tab.tab_id)).map((tab) => {
      const count = panes.filter((pane) => pane.tab_id === tab.tab_id).length;
      return count === tab.pane_count || !snapshot.panes.some((pane) => pane.tab_id === tab.tab_id) ? tab : { ...tab, pane_count: count };
    });
    const emptiedSpaces = new Set(snapshot.workspaces.filter((workspace) => snapshot.tabs.some((tab) => tab.workspace_id === workspace.workspace_id && emptied.has(tab.tab_id)) && !tabs.some((tab) => tab.workspace_id === workspace.workspace_id)).map((workspace) => workspace.workspace_id));
    const workspaces = snapshot.workspaces.filter((workspace) => !emptiedSpaces.has(workspace.workspace_id)).map((workspace) => {
      const own = tabs.filter((tab) => tab.workspace_id === workspace.workspace_id);
      const paneCount = panes.filter((pane) => pane.workspace_id === workspace.workspace_id).length;
      return own.length === workspace.tab_count && paneCount === workspace.pane_count ? workspace : { ...workspace, tab_count: own.length, pane_count: paneCount, ...(emptied.has(workspace.active_tab_id) && own[0] ? { active_tab_id: own[0].tab_id } : {}) };
    });
    return {
      ...machine,
      snapshot: {
        ...snapshot,
        panes,
        tabs,
        workspaces,
        agents: snapshot.agents.filter((agent) => !gone(agent)),
        layouts: snapshot.layouts.filter((layout) => !emptied.has(layout.tab_id)),
      },
    };
  });
}

/** The Tasks section's filter, remembered on this device: the open space's rows (the default) or every row. */
export type TasksScope = "space" | "all";

const SCOPE_KEY = "ovis.tasks.scope";

export function readTasksScope(): TasksScope {
  try { return window.localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "space"; } catch { return "space"; }
}

export function saveTasksScope(scope: TasksScope): void {
  try { window.localStorage.setItem(SCOPE_KEY, scope); } catch {}
}

/**
 * What This space narrows to: the open workspace when it is a Shepherdr space, else why every row shows. The section
 * exists only on a herdr-core server (server/index.ts), where each of this PC's workspaces is a Herdr app space under
 * the id Shepherdr names it by (a row's `place`), except Other terminals; another PC's workspace is none of them.
 */
export type TasksSpace = { kind: "space"; id: string; label: string } | { kind: "none" } | { kind: "not-shepherdr" };

export function tasksSpaceOf(machineId: string, workspace: { workspace_id: string; label: string } | null): TasksSpace {
  if (!workspace) return { kind: "none" };
  if (machineId !== LOCAL_MACHINE || workspace.workspace_id === HC_OTHER_WORKSPACE_ID) return { kind: "not-shepherdr" };
  return { kind: "space", id: workspace.workspace_id, label: workspace.label };
}

/**
 * A group as the section shows it. `count` is Shepherdr's own under All. Under This space it counts the listed rows of
 * that space, which is the whole count only while the feed lists every row of the group (`complete`); `unlisted` is
 * how many of the group's rows the feed leaves out, of any space.
 */
export interface ShownTaskGroup extends ShepherdrTaskGroup {
  rows: ShepherdrTaskRow[];
  complete: boolean;
  unlisted: number;
}

/** The groups under the filter: `place` null shows every row. Only what the section draws: nothing else follows it. */
export function shownTaskGroups(tasks: ShepherdrTasks, place: string | null): ShownTaskGroup[] {
  return tasks.groups.map((group) => {
    const listed = tasks.rows.filter((row) => row.group === group.kind);
    const unlisted = Math.max(0, group.count - listed.length);
    if (place === null) return { ...group, rows: listed, complete: true, unlisted };
    const rows = listed.filter((row) => row.place === place);
    return { ...group, count: rows.length, rows, complete: unlisted === 0, unlisted };
  });
}
