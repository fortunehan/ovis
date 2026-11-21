import { describe, expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { ShepherdrTaskRow, ShepherdrTasks } from "../../shared/shepherdr-tasks.ts";
import { sidebarAgents } from "../../shared/agent-roster.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { inboxOrder } from "./agentInbox.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";
import { withoutTaskTerminals } from "./shepherdrTasks.ts";

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
const local = fixture[0]!;
const lab: Machine = { ...JSON.parse(JSON.stringify(local)), id: "lab", name: "lab" };
const pcs = [local, lab];
const idle: SidebarActivity = { seqs: () => new Map(), status: () => "idle" };

const row = (key: string, terminals: string[]): ShepherdrTaskRow => ({
  key, group: "working", type: "task", ref: key, title: key, body: key, name: key, space: "infra", machine: "this machine", line: null,
  progress: null, left: null, at: null, open: terminals[0] ? { kind: "terminal", pane_id: terminals[0] } : { kind: "no-terminal" }, terminals,
});
const list = (rows: ShepherdrTaskRow[], stale = false): ShepherdrTasks => ({ groups: [{ kind: "working", label: "Working", count: rows.length }], rows, needs: 0, stale, at: 0 });

/** what the three lists draw: the workspace list's workspaces and panes, the agent list's and the Inbox's agents */
function shown(machines: readonly Machine[]) {
  return {
    workspaces: machines.map((machine) => `${machine.id}: ${machine.snapshot!.workspaces.map((workspace) => workspace.label).join(", ")}`),
    panes: machines.flatMap((machine) => machine.snapshot!.panes.map((pane) => `${machine.id}/${pane.pane_id}`)),
    agents: machines.flatMap((machine) => sidebarAgents(machine.snapshot).map((entry) => `${machine.id}/${entry.pane.pane_id}`)),
    inbox: inboxOrder(machines, idle).map(({ machine, entry }) => `${machine.id}/${entry.pane.pane_id}`),
  };
}

describe("task terminals the Tasks section lists", () => {
  it("leave the workspace list, the agent list and the Inbox of this PC, and nothing else does", () => {
    const before = shown(pcs);
    const after = shown(withoutTaskTerminals(pcs, list([row("OVIS-5", ["w1E:p1"]), row("OVIS-6", [])])));
    expect(after.workspaces).toEqual(["local: checkout-api, web-dashboard, docs-site, release", before.workspaces[1]!]);
    expect(after.panes).toEqual(before.panes.filter((pane) => pane !== "local/w1E:p1"));
    expect(after.agents).toEqual(before.agents.filter((pane) => pane !== "local/w1E:p1"));
    expect(after.inbox).toEqual(before.inbox.filter((pane) => pane !== "local/w1E:p1"));
    expect(after.inbox).toContain("lab/w1E:p1");
  });

  it("take their helpers and reviewers along (every terminal the row names)", () => {
    const after = shown(withoutTaskTerminals(pcs, list([row("OVIS-5", ["w1E:p1", "w1F:p1"])])));
    expect(after.agents.filter((pane) => pane.startsWith("local/"))).toEqual(["local/w1C:p1", "local/w1D:p1"]);
    expect(after.workspaces[0]).toBe("local: checkout-api, web-dashboard, release");
  });

  it("stay hidden while a dropped feed's last list is shown, and come back once the list is gone", () => {
    const stale = shown(withoutTaskTerminals(pcs, list([row("OVIS-5", ["w1E:p1"])], true)));
    expect(stale.agents).not.toContain("local/w1E:p1");
    expect(shown(withoutTaskTerminals(pcs, null))).toEqual(shown(pcs));
    expect(withoutTaskTerminals(pcs, null)).toEqual(pcs);
  });

  it("hide nothing when no row has a terminal here", () => {
    const rows = [{ ...row("ELIA-53", []), open: { kind: "other-machine" as const, machine: "Mac mini" } }, { ...row("SDS-17", []), open: { kind: "no-terminal" as const } }];
    expect(shown(withoutTaskTerminals(pcs, list(rows)))).toEqual(shown(pcs));
  });
});
