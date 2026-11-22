// The Tasks section on demo fixtures at 390 and 1440, light and dark: Shepherdr's groups in the feed's order with its
// counts and a "+N more" line, the drawer button's Needs you count, each kind of row (opens its terminal in chat view,
// opens an Assistant, another machine, no terminal, an automation's words), a listed task's terminals gone from the
// workspace list, the agent list and the Inbox, a dropped feed marked reconnecting, and no section and nothing hidden
// once the list is gone. The list is told as the server tells it (a `shepherdr-tasks` machine event).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { ShepherdrTasks } from "../shared/shepherdr-tasks.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

const app = mkdtempSync(join(tmpdir(), "ovis-tasks-section-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;

const row = (fields: Partial<ShepherdrTasks["rows"][number]> & Pick<ShepherdrTasks["rows"][number], "key" | "group" | "open">): ShepherdrTasks["rows"][number] => ({
  type: "task", ref: null, title: "", body: "", name: null, space: null, machine: "this machine", line: null, progress: null, left: null, at: null, terminals: [], ...fields,
});
const TASKS: ShepherdrTasks = {
  groups: [
    { kind: "needs", label: "Needs you", count: 3 },
    { kind: "ready", label: "Ready", count: 1 },
    { kind: "working", label: "Working", count: 1 },
    { kind: "done", label: "Done", count: 5 },
  ],
  rows: [
    row({ key: "need:INF-3/worker:q1", group: "needs", type: "need", ref: "INF-3", title: "INF-3 · Needs you", body: "Restore from last night?", name: "Why did the backup fail?", space: "infra", line: "Restore from last night?", progress: 60, left: "20m", open: { kind: "terminal", pane_id: "w1H:p1" }, terminals: ["w1H:p1"] }),
    row({ key: "need:pweb:q2", group: "needs", type: "need", assistant: true, title: "Assistant · Needs you", body: "Which branch should the export fix go on?", space: "web-dashboard", open: { kind: "terminal", pane_id: "w1D:p1" } }),
    row({ key: "auto:nightly", group: "needs", title: "nightly-tests · Didn't run", body: "The folder is gone", space: "checkout-api", open: { kind: "words" } }),
    row({ key: "ready:m3:VIBE-10", group: "ready", ref: "VIBE-10", title: "VIBE-10 · Finished", body: "Voice: fix lag", name: "Voice: fix lag", space: "Home", machine: "Mac mini", line: "Ready 2h ago", open: { kind: "other-machine", machine: "Mac mini" }, accept: { task: "m3:VIBE-10" } }),
    row({ key: "task:PAY-7", group: "working", ref: "PAY-7", title: "PAY-7 · Working", body: "Idempotent payments", name: "Idempotent payments", space: "checkout-api", line: "Writing the retry tests", progress: 35, left: "1h", open: { kind: "terminal", pane_id: "w1C:p1" }, terminals: ["w1C:p1"] }),
    row({ key: "task:DOC-2", group: "done", ref: "DOC-2", title: "DOC-2 · Done", body: "Proofread the guide", name: "Proofread the guide", space: "docs-site", line: "Merged", open: { kind: "no-terminal" } }),
  ],
  needs: 3,
  stale: false,
  at: 1,
};

// the demo's event stream, with the server's `shepherdr-tasks` event after each roster it sends, and a way to tell another
const patch = `(() => {
  const EventSourceDemo = window.EventSource;
  const sources = new Set();
  let tasks = ${JSON.stringify(TASKS)};
  const event = () => JSON.stringify(tasks ? { type: "shepherdr-tasks", tasks } : { type: "shepherdr-tasks" });
  window.tasksSet = (next) => { tasks = next; for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: event() })); };
  window.tasksNow = () => tasks;
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1;
      sources.add(this);
      this.inner.onmessage = (message) => {
        this.onmessage?.(message);
        if (JSON.parse(message.data).type === "machines") this.onmessage?.(new MessageEvent("message", { data: event() }));
      };
      this.inner.onerror = (error) => this.onerror?.(error);
      this.inner.onopen = (open) => this.onopen?.(open);
    }
    close() { this.inner.close(); this.readyState = 2; sources.delete(this); }
  };
})();`;

declare global {
  interface Window {
    tasksSet(next: ShepherdrTasks | null): void;
    tasksNow(): ShepherdrTasks | null;
  }
}

let origin = "";
type Theme = "light" | "dark";

async function open(browser: Browser, width: number, theme: Theme): Promise<{ page: Page; errors: string[]; phone: boolean; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, locale: "en-US", hasTouch: phone, isMobile: phone, colorScheme: theme });
  await context.addInitScript((chosen) => {
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: chosen }));
  }, theme);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?pane=${encodeURIComponent("w1G:p1")}&view=terminal`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { page, errors, phone, close: () => context.close() };
}

const section = (page: Page) => page.locator(".sidebar .tasks-sidebar");
const agentPanes = (page: Page) => page.locator('.sidebar .agent-item[data-machine="local"]').evaluateAll((items) => items.map((item) => item.getAttribute("data-pane")));
const workspaces = (page: Page) => page.locator(".sidebar .workspace-group").evaluateAll((items) => items.map((item) => item.getAttribute("data-workspace")));
const workspacePanes = (page: Page) => page.locator(".sidebar .workspace-group [data-pane]").evaluateAll((items) => items.map((item) => item.getAttribute("data-pane")));
const selected = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "null"));

async function drawer(page: Page, phone: boolean): Promise<void> {
  if (phone && !(await page.locator("#workspace-drawer.is-open").count())) await page.locator("#drawer-toggle").click();
  await section(page).waitFor();
}

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "tasks-section.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./tasks-section.js"></script><script type="module"'));
  const server = serveDemo(app, { prefix: "/" });
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      if (evidence) mkdirSync(evidence, { recursive: true });
      for (const width of [390, 1440]) for (const theme of ["light", "dark"] as const) {
        const { page, errors, phone, close } = await open(browser, width, theme);
        try {
          if (phone) {
            const toggle = page.locator("#drawer-toggle");
            await toggle.locator(".header-more-dot").waitFor();
            assert.equal(await toggle.locator(".header-more-dot").getAttribute("data-count"), "3", "the drawer button shows Shepherdr's Needs you count");
            assert.match((await toggle.getAttribute("aria-label")) ?? "", /Tasks: 3 need you/);
            if (evidence && theme === "light") await page.locator(".app-header").screenshot({ path: join(evidence, `tasks-badge-${width}.png`) });
          }
          await drawer(page, phone);
          const heads = await section(page).locator(".tasks-group-toggle").evaluateAll((items) => items.map((item) => item.textContent));
          assert.deepEqual(heads, ["Needs you3", "Ready1", "Working1", "Done5"], "Shepherdr's groups, in its order, with its counts");
          assert.equal((await section(page).locator(".tasks-group.is-done .tasks-more").textContent())?.trim(), "+4 more");
          assert.equal(await section(page).locator(".tasks-group.is-needs .tasks-more").count(), 0);
          const first = section(page).locator("button.task-row").first();
          assert.match((await first.textContent()) ?? "", /INF-3.*Why did the backup fail\?.*60% · 20m left.*infra · Restore from last night\?/);
          assert.match((await section(page).locator(".task-row.is-ready").textContent()) ?? "", /On Mac mini, can't be opened from this PC/);
          assert.equal(await section(page).locator(".task-row.is-ready").evaluate((item) => item.tagName), "DIV", "a row on another machine opens nothing");
          assert.match((await section(page).locator(".task-row.is-done").textContent()) ?? "", /No terminal running/);
          assert.equal(await section(page).locator(".task-row.is-needs.is-inert").count(), 1, "an automation's row only shows its words");

          const agents = await agentPanes(page);
          assert.ok(!agents.includes("w1H:p1") && !agents.includes("w1C:p1"), `a listed task's terminal leaves the agent list (${agents.join(", ")})`);
          assert.ok(agents.includes("w1D:p1"), "an Assistant whose card is listed stays");
          const spaces = await workspaces(page);
          assert.ok(!spaces.includes("w1H"), `a workspace left with no pane leaves the workspace list (${spaces.join(", ")})`);
          assert.ok(spaces.includes("w1C") && spaces.includes("w1D"), "a workspace that keeps another tab stays");
          const listed = await workspacePanes(page);
          assert.ok(!listed.includes("w1C:p1") && !listed.includes("w1H:p1") && listed.includes("w1D:p1"), `a listed task's terminal leaves its workspace (${listed.join(", ")})`);
          if (evidence) await page.locator(".sidebar").screenshot({ path: join(evidence, `tasks-section-${width}-${theme}.png`) });

          await first.click();
          await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "null")?.pane_id === "w1H:p1");
          assert.deepEqual(await selected(page), { machine_id: "local", pane_id: "w1H:p1" });
          if (phone) await page.locator(".chat-view, .chat-timeline").first().waitFor();
          await drawer(page, phone);
          await section(page).locator("button.task-row", { hasText: "web-dashboard" }).click();
          await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "null")?.pane_id === "w1D:p1");

          await drawer(page, phone);
          await page.evaluate(() => window.tasksSet({ ...window.tasksNow()!, stale: true }));
          await section(page).locator(".tasks-stale", { hasText: "Reconnecting to Shepherdr…" }).waitFor();
          assert.ok(!(await agentPanes(page)).includes("w1H:p1"), "a dropped feed's last list still hides");
          if (evidence && theme === "light") await section(page).screenshot({ path: join(evidence, `tasks-stale-${width}.png`) });

          await page.evaluate(() => window.tasksSet(null));
          await section(page).waitFor({ state: "detached" });
          await page.waitForFunction(() => document.querySelector('.sidebar .agent-item[data-pane="w1H:p1"]') !== null);
          const back = await agentPanes(page);
          assert.ok(back.includes("w1C:p1") && back.includes("w1H:p1"), `with no list, nothing is hidden (${back.join(", ")})`);
          assert.ok((await workspaces(page)).includes("w1H"), "with no list, a task's workspace is back");
          if (phone) assert.equal(await page.locator("#drawer-toggle .header-more-dot").count(), 0);

          if (!phone) {
            await page.evaluate(() => window.tasksSet(null));
            await page.evaluate((tasks) => window.tasksSet(tasks), TASKS);
            await section(page).waitFor();
            await page.getByRole("button", { name: "Open agent inbox" }).first().click();
            await page.locator(".inbox-item").first().waitFor();
            const inbox = await page.locator('.inbox-item[data-machine="local"]').evaluateAll((items) => items.map((item) => item.getAttribute("data-pane")));
            assert.ok(!inbox.includes("w1H:p1") && !inbox.includes("w1C:p1") && inbox.includes("w1D:p1"), `a listed task's terminal leaves the Inbox (${inbox.join(", ")})`);
            if (evidence && theme === "light") await page.locator(".inbox-column").screenshot({ path: join(evidence, `tasks-inbox-${width}.png`) });
          }
          assert.deepEqual(errors, []);
        } finally { await close(); }
        console.log(`PASS ${width}px ${theme}: groups, counts and +N more as told, the Needs you badge, every kind of row, task terminals hidden while listed, reconnecting, and nothing once the list is gone`);
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
