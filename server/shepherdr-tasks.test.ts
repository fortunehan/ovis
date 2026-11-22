import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoPrefix, readGlance, readTaskIdentities, shepherdrPaths, sseEvents, ShepherdrFeed, tasksOf, type GlanceDoc, type ShepherdrPaths, type TerminalFacts } from "./shepherdr-tasks.ts";

const dirs: string[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "ovis-shepherdr-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const groups = [
  { kind: "needs", label: "Needs you", count: 3 },
  { kind: "ready", label: "Ready", count: 1 },
  { kind: "working", label: "Working", count: 5 },
  { kind: "done", label: "Done", count: 0 },
];

function feedDoc(items: Record<string, unknown>[]): GlanceDoc {
  return readGlance({ format: 1, v: "a", urgent: "b", at: 1, counts: {}, order: groups.map((group) => group.kind), groups, items, unread: 0 })!;
}

const terminal = (address: string, labels: Record<string, string> = {}, parent: string | null = null, state = "live"): TerminalFacts => ({ address, state, labels, parent });

describe("the Tasks section's rows", () => {
  const identities = new Map([
    ["OVIS-5", { label: "Codes-Lab-ovis#5", agents: [] }],
    ["OVIS-6", { label: "Codes-Lab-ovis#6", agents: [] }],
    ["SHEP-9", { label: "Codes-Lab-shepherdr#9", agents: ["t30"] }],
  ]);
  const terminals = [
    terminal("t10", { "herdr.role": "coordinator", "herdr.coordinator.space": "sp1", "herdr.chat": "pchat1" }),
    terminal("t11", { "herdr.task": "Codes-Lab-ovis#5", "herdr.agent": "claude" }, "t10"),
    terminal("t12", { "herdr.task": "Codes-Lab-ovis#5", "herdr.role": "reviewer" }, "t11"),
    terminal("t13", {}, "t11"),
    terminal("t14", { "herdr.task": "Codes-Lab-ovis#6" }, "t10", "finished"),
    terminal("t30", {}, "t10"),
    terminal("vps/t2", { "herdr.task": "Codes-Lab-ovis#5" }),
  ];
  const tasks = tasksOf(feedDoc([
    { key: "need:SDS-1/worker:q1", kind: "needs", type: "need", task: "OVIS-5", title: "OVIS-5 · Needs you", body: "Rerun CI?", name: "Tasks section", space: "ovis", machine: "this machine", line: "Rerun CI?", progress: 40, left: "1h", url: "./?place=sp1&task=OVIS-5", answer: { chat: "OVIS-5/worker", question: "q1", choices: [{ i: 0, label: "Yes" }], other: true } },
    { key: "need:pchat1:q2", kind: "needs", type: "need", title: "Assistant · Needs you", body: "Which repo?", space: "ovis", machine: "this machine", url: "./?place=sp1", answer: { chat: "pchat1", question: "q2", choices: [] } },
    { key: "auto:nightly", kind: "needs", type: "need", title: "nightly · Didn't run", body: "no such folder", space: "ovis", url: "./?place=sp1" },
    { key: "ready:OVIS-6", kind: "ready", type: "task", task: "OVIS-6", title: "OVIS-6 · Finished", body: "Accept", name: "Accept", url: "./#accept=OVIS-6", accept: { task: "OVIS-6" } },
    { key: "task:m3:VIBE-10", kind: "working", type: "task", task: "m3:VIBE-10", title: "VIBE-10 · Working", body: "Voice", name: "Voice", machine: "Mac mini", url: "./?place=m3%2Fsp4&task=m3%3AVIBE-10" },
    { key: "task:SHEP-9", kind: "working", type: "task", task: "SHEP-9", title: "SHEP-9 · Working", body: "Links", name: "Links", url: "./?place=sp2&task=SHEP-9" },
  ]), false, terminals, identities);
  const byKey = new Map(tasks.rows.map((row) => [row.key, row]));

  it("keeps Shepherdr's groups, order, counts and words", () => {
    expect(tasks.groups).toEqual(groups);
    expect(tasks.needs).toBe(3);
    expect(tasks.rows.map((row) => row.group)).toEqual(["needs", "needs", "needs", "ready", "working", "working"]);
    const first = byKey.get("need:SDS-1/worker:q1")!;
    expect([first.ref, first.name, first.space, first.line, first.progress, first.left]).toEqual(["OVIS-5", "Tasks section", "ovis", "Rerun CI?", 40, "1h"]);
    expect(first.answer).toEqual({ chat: "OVIS-5/worker", question: "q1", choices: [{ i: 0, label: "Yes" }], other: true });
    expect(byKey.get("ready:OVIS-6")!.accept).toEqual({ task: "OVIS-6" });
  });

  it("opens a task's own agent here, with its helpers and reviewers as its terminals", () => {
    const row = byKey.get("need:SDS-1/worker:q1")!;
    expect(row.open).toEqual({ kind: "terminal", pane_id: "t11" });
    expect(row.terminals).toEqual(["t11", "t12", "t13"]);
  });

  it("finds a task's agent by the address herdr-task recorded too", () => {
    expect(byKey.get("task:SHEP-9")!.open).toEqual({ kind: "terminal", pane_id: "t30" });
  });

  it("says no terminal for a task here whose terminals all ended", () => {
    const row = byKey.get("ready:OVIS-6")!;
    expect(row.open).toEqual({ kind: "no-terminal" });
    expect(row.terminals).toEqual([]);
  });

  it("names the other machine for a task that runs there, and holds no terminal", () => {
    const row = byKey.get("task:m3:VIBE-10")!;
    expect(row.ref).toBe("VIBE-10");
    expect(row.open).toEqual({ kind: "other-machine", machine: "Mac mini" });
    expect(row.terminals).toEqual([]);
  });

  it("opens an Assistant's own card on that Assistant, without hiding it", () => {
    const row = byKey.get("need:pchat1:q2")!;
    expect(row.assistant).toBe(true);
    expect(row.open).toEqual({ kind: "terminal", pane_id: "t10" });
    expect(row.terminals).toEqual([]);
  });

  it("only shows an automation's words", () => {
    expect(byKey.get("auto:nightly")!.open).toEqual({ kind: "words" });
  });
});

describe("the feed's doc", () => {
  it("is read only in format 1", () => {
    expect(readGlance({ format: 1, groups, items: [] })).not.toBeNull();
    expect(readGlance({ format: 2, groups, items: [] })).toBeNull();
    expect(readGlance({ groups, items: [] })).toBeNull();
    expect(readGlance({ format: 1, groups: [{ kind: "needs" }], items: [] })).toBeNull();
  });

  it("comes in event stream frames, cut anywhere", () => {
    const first = sseEvents("retry: 5000\n\nevent: glance\ndata: {\"a\":1}\n\n: ping\n\nevent: glance\ndata: {\"a\"");
    expect(first.events).toEqual([{ event: "glance", data: "{\"a\":1}" }]);
    expect(sseEvents(first.rest + ":2}\n\n").events).toEqual([{ event: "glance", data: "{\"a\":2}" }]);
  });
});

describe("Shepherdr's files on this PC", () => {
  it("are its own folders once its data moved, else the old ones", () => {
    const home = tempDir();
    expect(shepherdrPaths(home, {})).toEqual({ serviceFile: join(home, ".herdr/shepherdr/service.json"), tokenFile: join(home, ".herdr/shepherdr/token"), tasksDir: join(home, ".herdr/tasks") });
    mkdirSync(join(home, ".local/share/shepherdr"), { recursive: true });
    writeFileSync(join(home, ".local/share/shepherdr/LAYOUT"), "2\n");
    expect(shepherdrPaths(home, {})).toEqual({ serviceFile: join(home, ".local/state/shepherdr/service/service.json"), tokenFile: join(home, ".local/state/shepherdr/service/token"), tasksDir: join(home, ".local/share/shepherdr/tasks") });
    expect(shepherdrPaths(home, { SHEPHERDR_HOME: "/x" }).serviceFile).toBe(join(home, ".herdr/shepherdr/service.json"));
  });

  it("name each task by its ref, with a list's own prefix or herdr-task's", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Codes-Lab-ovis.json"), JSON.stringify({ folder: "/c/ovis", prefix: "OVIS", tasks: [{ id: 5, agents: [{ address: "t9", ended: 1 }, { address: "t11" }] }] }));
    writeFileSync(join(dir, "Codes-herdr-app-ttt.json"), JSON.stringify({ folder: "/c/herdr-app-ttt", tasks: [{ id: 2 }] }));
    writeFileSync(join(dir, "broken.json"), "{");
    expect(Object.fromEntries(readTaskIdentities(dir))).toEqual({
      "OVIS-5": { label: "Codes-Lab-ovis#5", agents: ["t11"] },
      "HAT-2": { label: "Codes-herdr-app-ttt#2", agents: [] },
    });
    expect(autoPrefix("/c/herdrWeb")).toBe("HW");
  });
});

describe("following the feed", () => {
  const doc = { format: 1, v: "a", urgent: "b", at: 7, counts: {}, order: ["needs"], groups: [{ kind: "needs", label: "Needs you", count: 0 }], items: [], unread: 0 };
  function setup(health: Record<string, unknown>, frames: string[], close = true): { paths: ShepherdrPaths; asked: string[]; sentToken: () => boolean; fetch: (url: string, init?: RequestInit) => Promise<Response> } {
    const dir = tempDir();
    const paths = { serviceFile: join(dir, "service.json"), tokenFile: join(dir, "token"), tasksDir: join(dir, "tasks") };
    writeFileSync(paths.serviceFile, JSON.stringify({ port: 7788, id: "right" }));
    writeFileSync(paths.tokenFile, "secret\n");
    const asked: string[] = [];
    let token = false;
    const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      asked.push(url);
      if (url.endsWith("/api/health")) return Response.json(health);
      if (new Headers(init?.headers).get("authorization") === "Bearer secret") token = true;
      if (new Headers(init?.headers).get("origin")) return new Response("no", { status: 403 });
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
        if (close) controller.close();
      } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    return { paths, asked, sentToken: () => token, fetch };
  }

  const until = async (done: () => boolean) => { const deadline = Date.now() + 5_000; while (!done()) { if (Date.now() > deadline) throw new Error("the feed never got there"); await Bun.sleep(5); } };

  it("reads the feed with the token once health answers the service file's id, and keeps a dropped feed's list a while", async () => {
    const seen: Array<{ at: number | null; stale: boolean }> = [];
    const { paths, asked, sentToken, fetch } = setup({ app: "shepherdr", id: "right", serving: true }, [`retry: 5000\n\nevent: glance\ndata: ${JSON.stringify(doc)}\n\n`]);
    const feed = new ShepherdrFeed({ paths, fetch, staleMs: 60, retryMs: [60_000], onDoc: (got, stale) => seen.push({ at: got?.at ?? null, stale }) });
    feed.start();
    await until(() => seen.length >= 3);
    feed.stop();
    expect(sentToken()).toBe(true);
    expect(asked).toEqual(["http://127.0.0.1:7788/api/health", "http://127.0.0.1:7788/api/glance?stream=1"]);
    expect(seen).toEqual([{ at: 7, stale: false }, { at: 7, stale: true }, { at: null, stale: false }]);
  });

  it("never sends the token to a service whose health answers another id", async () => {
    const seen: unknown[] = [];
    const { paths, asked, sentToken, fetch } = setup({ app: "shepherdr", id: "other", serving: true }, []);
    const feed = new ShepherdrFeed({ paths, fetch, retryMs: [60_000], onDoc: (got) => seen.push(got) });
    feed.start();
    await until(() => asked.length >= 1);
    await Bun.sleep(20); // fixed wait: proving nothing more is asked after the refusal
    feed.stop();
    expect(asked).toEqual(["http://127.0.0.1:7788/api/health"]);
    expect(sentToken()).toBe(false);
    expect(seen).toEqual([]);
  });

  it("reads nothing where another machine serves Shepherdr", async () => {
    const { paths, asked, fetch } = setup({ app: "shepherdr", id: "right", serving: false }, []);
    const feed = new ShepherdrFeed({ paths, fetch, retryMs: [60_000], onDoc: () => {} });
    feed.start();
    await until(() => asked.length >= 1);
    await Bun.sleep(20); // fixed wait: proving nothing more is asked after the refusal
    feed.stop();
    expect(asked).toEqual(["http://127.0.0.1:7788/api/health"]);
  });

  it("drops the list at once for a feed in another format", async () => {
    const seen: Array<{ at: number | null; stale: boolean }> = [];
    const { paths, fetch } = setup({ app: "shepherdr", id: "right", serving: true }, [`event: glance\ndata: ${JSON.stringify(doc)}\n\n`, `event: glance\ndata: ${JSON.stringify({ ...doc, format: 2, at: 8 })}\n\n`], false);
    const feed = new ShepherdrFeed({ paths, fetch, staleMs: 60_000, retryMs: [60_000], onDoc: (got, stale) => seen.push({ at: got?.at ?? null, stale }) });
    feed.start();
    await until(() => seen.length >= 2);
    feed.stop();
    expect(seen).toEqual([{ at: 7, stale: false }, { at: null, stale: false }]);
  });

  it("reads nothing without a service file", async () => {
    const asked: string[] = [];
    const dir = tempDir();
    const feed = new ShepherdrFeed({ paths: { serviceFile: join(dir, "none.json"), tokenFile: join(dir, "token"), tasksDir: dir }, fetch: async (url) => { asked.push(url); return new Response(); }, retryMs: [60_000], onDoc: () => {} });
    feed.start();
    await Bun.sleep(20); // fixed wait: proving nothing more is asked after the refusal
    feed.stop();
    expect(asked).toEqual([]);
  });
});
