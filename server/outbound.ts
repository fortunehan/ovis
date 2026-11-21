/**
 * Every connection this server opens beyond this machine goes through here (docs/relay.md, "Proxy-only mode").
 *
 * - Proxy-only mode (`OVIS_OUTBOUND_PROXY_ONLY=1`): the outbound proxy (`HTTPS_PROXY`, then `https_proxy`, an
 *   `http://` address) carries every destination. Relay traffic goes through it whatever the bypass list (`NO_PROXY`)
 *   says, even to a loopback relay; every other connection honours the bypass list, and loopback and unix sockets are
 *   never proxied. Nothing ever falls back to a direct dial: a missing, malformed or unreachable proxy refuses.
 * - Off: a set `HTTPS_PROXY` is used as a best effort and the bypass list is honoured (Bun's fetch does that by
 *   itself; its WebSocket ignores the proxy variables, so sockets are given the proxy here).
 *
 * The rest of server/ and shared/ never calls the global `fetch` or `new WebSocket` (server/conventions.test.ts):
 * `outboundFetch`/`relayFetch`/`outboundWebSocket`/`relayWebSocket` for the network, `localFetch`/`localWebSocket`
 * for this machine. In proxy-only mode `installOutboundGuard` also replaces the globals, so a dial that slips past
 * this module is refused and logged instead of leaving directly.
 */
import { BlockList, isIP } from "node:net";
import type { OutboundHealth } from "../shared/protocol.ts";
import { isLoopbackBind } from "./access.ts";

/** Relay traffic ignores the bypass list in proxy-only mode; everything else honours it. */
export type OutboundKind = "relay" | "other";

export interface OutboundPolicy {
  readonly proxyOnly: boolean;
  /** The proxy URL as given, credentials included; null when none is set or it cannot be used. */
  readonly proxy: string | null;
  /** `host:port` of the proxy, never its credentials. */
  readonly display: string | null;
  /** Why proxy-only mode has no usable proxy (missing or malformed address); null when it has one or is off. */
  readonly invalid: string | null;
  readonly bypass: readonly string[];
  /** `HTTP_PROXY` off proxy-only mode, for a plain `ws:` socket; proxy-only mode never reads it. */
  readonly plainProxy: string | null;
}

export interface OutboundRefusal {
  readonly at: string;
  readonly kind: OutboundKind;
  /** `host:port` that was not reached */
  readonly target: string;
  readonly reason: string;
}

export type OutboundStatus = OutboundHealth;

export class OutboundRefusedError extends Error {
  readonly code = "outbound_refused";
  constructor(readonly refusal: OutboundRefusal) {
    super(`Refused by proxy-only mode: ${refusal.reason}`);
    this.name = "OutboundRefusedError";
  }
}

/** Kept before any guard replaces the globals: this module alone dials with them. */
const nativeFetch: typeof fetch = globalThis.fetch;
const NativeWebSocket: typeof WebSocket = globalThis.WebSocket;

const PROXY_NAMES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;

function describeProxy(url: URL): string {
  return `${url.hostname.includes(":") ? `[${url.hostname}]` : url.hostname}:${url.port || "80"}`;
}

export function readOutboundPolicy(env: Record<string, string | undefined>): OutboundPolicy {
  const proxyOnly = env["OVIS_OUTBOUND_PROXY_ONLY"] === "1";
  const raw = (env["HTTPS_PROXY"] || env["https_proxy"] || "").trim();
  const bypass = (env["NO_PROXY"] ?? env["no_proxy"] ?? "").split(/[\s,]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const plainProxy = (env["HTTP_PROXY"] || env["http_proxy"] || "").trim() || null;
  if (raw === "") return { proxyOnly, proxy: null, display: null, invalid: proxyOnly ? "proxy-only mode is on, but HTTPS_PROXY is not set" : null, bypass, plainProxy };
  let url: URL | null = null;
  try { url = new URL(raw); } catch {}
  const usable = url !== null && url.protocol === "http:" && url.hostname !== "" && (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash;
  if (!usable) return { proxyOnly, proxy: null, display: null, invalid: proxyOnly ? "HTTPS_PROXY is not an http://host:port address" : null, bypass, plainProxy };
  return { proxyOnly, proxy: raw, display: describeProxy(url!), invalid: null, bypass, plainProxy };
}

let policy: OutboundPolicy = readOutboundPolicy(process.env);
let latestRefusal: OutboundRefusal | null = null;
let latestRelayRefusal: OutboundRefusal | null = null;

/** Reads the policy again from `env`: the server's start does, and tests with an environment of their own. */
export function configureOutbound(env: Record<string, string | undefined> = process.env): OutboundPolicy {
  policy = readOutboundPolicy(env);
  latestRefusal = null;
  latestRelayRefusal = null;
  return policy;
}

export function outboundPolicy(): OutboundPolicy { return policy; }
export function proxyOnly(): boolean { return policy.proxyOnly; }

/** What `/api/health` reports: the policy, the proxy without credentials, and the latest refusal. */
export function outboundStatus(): OutboundStatus {
  return { proxy_only: policy.proxyOnly, proxy: policy.display, invalid: policy.invalid, latest_refusal: latestRefusal };
}

/** Why the relay is refused right now, for Settings; null once a relay socket opened through the proxy again. */
export function relayRefusal(): string | null { return policy.proxyOnly ? latestRelayRefusal?.reason ?? null : null; }

function targetOf(url: URL): string {
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  return `${url.hostname}:${port}`;
}

function refuse(kind: OutboundKind, url: URL | string, reason: string): OutboundRefusedError {
  const target = typeof url === "string" ? url : targetOf(url);
  const refusal: OutboundRefusal = { at: new Date().toISOString(), kind, target, reason };
  latestRefusal = refusal;
  if (kind === "relay") latestRelayRefusal = refusal;
  console.error(JSON.stringify({ event: "outbound.refused", ...refusal }));
  return new OutboundRefusedError(refusal);
}

function hostOf(url: URL): string { return url.hostname.replace(/^\[|\]$/g, "").toLowerCase(); }

/** This machine: loopback by name or address. Unix sockets are local by the call (`unix`, `ws+unix:`). */
export function isLocalUrl(url: URL): boolean {
  if (url.protocol === "ws+unix:" || url.protocol === "unix:") return true;
  return isLoopbackBind(url.hostname);
}

/** `NO_PROXY` as curl reads it: `*`, a host and its subdomains (with or without a leading dot), `host:port`, an IP or CIDR. */
export function bypassed(url: URL, entries: readonly string[] = policy.bypass): boolean {
  const host = hostOf(url);
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  for (const raw of entries) {
    if (raw === "*") return true;
    let entry = raw, entryPort: string | null = null;
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (bracketed) { entry = bracketed[1]!; entryPort = bracketed[2] ?? null; }
    else if (isIP(entry) === 0 && !entry.includes("/")) {
      const colon = entry.lastIndexOf(":");
      if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) { entryPort = entry.slice(colon + 1); entry = entry.slice(0, colon); }
    }
    if (entryPort !== null && entryPort !== port) continue;
    if (entry.includes("/")) {
      const [base, bits] = entry.split("/");
      const family = isIP(base!);
      const hostFamily = isIP(host);
      if (family === 0 || hostFamily !== family || !/^\d+$/.test(bits ?? "")) continue;
      const list = new BlockList();
      try { list.addSubnet(base!, Number(bits), family === 4 ? "ipv4" : "ipv6"); } catch { continue; }
      if (list.check(host, family === 4 ? "ipv4" : "ipv6")) return true;
      continue;
    }
    const name = entry.replace(/^\*?\./, "");
    if (name === "") continue;
    if (host === name || (isIP(host) === 0 && host.endsWith(`.${name}`))) return true;
  }
  return false;
}

/**
 * The proxy a connection to `url` goes through: a URL, null for a direct dial, or a refusal (thrown). `fetch` off proxy-only
 * mode answers undefined: Bun's fetch reads the proxy variables and the bypass list itself, as it always has.
 */
function route(url: URL, kind: OutboundKind, socket: boolean): string | null | undefined {
  if (policy.proxyOnly) {
    // a relay is relay traffic even on this machine: in proxy-only mode it has one way out
    if (kind === "other" && isLocalUrl(url)) return null;
    if (policy.proxy === null) throw refuse(kind, url, policy.invalid ?? "proxy-only mode has no outbound proxy");
    if (kind === "other" && bypassed(url)) return null;
    return policy.proxy;
  }
  if (isLocalUrl(url)) return null;
  if (!socket) return undefined;
  const secure = url.protocol === "wss:" || url.protocol === "https:";
  const proxy = secure ? policy.proxy : policy.plainProxy;
  if (proxy === null || bypassed(url)) return null;
  return proxy;
}

let probing: Promise<boolean> | null = null;
/** Whether the proxy takes a TCP connection: tells "can't be reached" from "would not open a tunnel". */
function proxyAnswers(): Promise<boolean> {
  const proxy = policy.proxy;
  if (proxy === null) return Promise.resolve(false);
  probing ??= (async () => {
    const url = new URL(proxy);
    try {
      const socket = await Bun.connect({ hostname: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80), socket: { data() {} } });
      socket.end();
      return true;
    } catch { return false; }
  })().finally(() => { probing = null; });
  return probing;
}

async function failedThroughProxy(kind: OutboundKind, url: URL, detail: string): Promise<void> {
  const answers = await proxyAnswers();
  refuse(kind, url, answers
    ? `proxy ${policy.display} did not open a tunnel to ${targetOf(url)}${detail ? ` (${detail})` : ""}`
    : `proxy ${policy.display} can't be reached`);
}

function urlOf(input: string | URL | Request): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

type FetchInit = RequestInit & { unix?: string; proxy?: string };

/** A connection beyond this machine: through the outbound proxy as the policy says. */
export async function outboundFetch(input: string | URL | Request, init?: FetchInit, kind: OutboundKind = "other"): Promise<Response> {
  if (init?.unix !== undefined) return nativeFetch(input, init);
  const url = urlOf(input);
  const proxy = route(url, kind, false);
  if (proxy === undefined || proxy === null) return nativeFetch(input, init);
  try {
    const response = await nativeFetch(input, { ...init, proxy });
    if (kind === "relay") latestRelayRefusal = null;
    return response;
  } catch (error) {
    const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    if (policy.proxyOnly && !aborted) await failedThroughProxy(kind, url, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Relay traffic: relay health probes, relay passes from the account service, push to the push relay. */
export function relayFetch(input: string | URL | Request, init?: FetchInit): Promise<Response> {
  return outboundFetch(input, init, "relay");
}

/** A socket beyond this machine, given the outbound proxy explicitly: Bun's WebSocket never reads the proxy variables. */
export function outboundWebSocket(address: string, init: { headers?: Record<string, string> } = {}, kind: OutboundKind = "other"): WebSocket {
  const url = new URL(address);
  const proxy = route(url, kind, true);
  const options = { ...init, ...(proxy ? { proxy } : {}) };
  const socket = new NativeWebSocket(address, (Object.keys(options).length > 0 ? options : undefined) as unknown as string[]);
  if (proxy && policy.proxyOnly) {
    let opened = false;
    socket.addEventListener("open", () => { opened = true; if (kind === "relay") latestRelayRefusal = null; });
    socket.addEventListener("close", () => { if (!opened) void failedThroughProxy(kind, url, ""); });
  }
  return socket;
}

/** Relay sockets (control, data, warm), typed pairing codes and the relay channel used to add another PC. */
export function relayWebSocket(address: string, init: { headers?: Record<string, string> } = {}): WebSocket {
  return outboundWebSocket(address, init, "relay");
}

function assertLocal(url: URL, unix: boolean): void {
  if (!unix && !isLocalUrl(url)) throw new Error(`${url.origin} is not on this machine; use outboundFetch or outboundWebSocket`);
}

/** This machine only (loopback or a unix socket): never proxied, and refused for anything else. */
export function localFetch(input: string | URL | Request, init?: FetchInit): Promise<Response> {
  assertLocal(urlOf(input), init?.unix !== undefined);
  return nativeFetch(input, init);
}

export function localWebSocket(address: string, init?: { headers?: Record<string, string> }): WebSocket {
  assertLocal(new URL(address), false);
  return new NativeWebSocket(address, init as unknown as string[]);
}

/**
 * A direct connection between PCs on the local network (a direct carrier on another PC's private or Tailscale
 * address): never proxied, and refused in proxy-only mode, which turns every local-network carrier off.
 */
export function localNetworkWebSocket(address: string): WebSocket {
  if (policy.proxyOnly) throw refuse("other", new URL(address), "local-network carriers are turned off by proxy-only mode");
  return new NativeWebSocket(address);
}

/**
 * Why the server may not start under `policy` listening on `hostname`, or null: proxy-only mode needs a usable proxy
 * address, and listens on loopback only (`tailscale serve` in front of loopback is unaffected).
 */
export function proxyOnlyStartRefusal(policy: OutboundPolicy, hostname: string): string | null {
  if (!policy.proxyOnly) return null;
  if (policy.invalid !== null) return `Ovis cannot start in proxy-only mode (OVIS_OUTBOUND_PROXY_ONLY=1): ${policy.invalid}. Set HTTPS_PROXY=http://host:port, or unset OVIS_OUTBOUND_PROXY_ONLY.`;
  if (!isLoopbackBind(hostname)) return `Ovis cannot start in proxy-only mode (OVIS_OUTBOUND_PROXY_ONLY=1): it listens on loopback only, and HOST=${hostname} is not. Unset HOST or set HOST=127.0.0.1.`;
  return null;
}

export class ProxyOnlyStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyOnlyStartError";
  }
}

/** Thrown where a local-network feature is asked for in proxy-only mode. */
export class LocalNetworkOffError extends Error {
  readonly code = "proxy_only";
  constructor(feature: string) {
    super(`${feature} are turned off by proxy-only mode (OVIS_OUTBOUND_PROXY_ONLY=1).`);
    this.name = "LocalNetworkOffError";
  }
}

export function assertLocalNetworkAllowed(feature: string): void {
  if (policy.proxyOnly) throw new LocalNetworkOffError(feature);
}

/**
 * The environment of a child that reaches the network (git fetch, herdr and hc updates, curl, CLI logins): in
 * proxy-only mode every proxy variable is the outbound proxy, so the child never connects directly either.
 */
export function networkEnv(base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  if (!policy.proxyOnly || policy.proxy === null) return { ...base };
  const env = { ...base };
  for (const name of PROXY_NAMES) env[name] = policy.proxy;
  return env;
}

/** The same, written into this process's own environment: children that inherit it are covered too. */
export function forceProxyEnv(env: Record<string, string | undefined> = process.env): void {
  if (!policy.proxyOnly || policy.proxy === null) return;
  for (const name of PROXY_NAMES) env[name] = policy.proxy;
}

/**
 * In proxy-only mode, the global `fetch` and `WebSocket` refuse (and log) anything beyond this machine: a dial
 * that slipped past this module never leaves directly. Answers a function that puts the originals back.
 */
export function installOutboundGuard(): () => void {
  if (!policy.proxyOnly) return () => {};
  const guardedFetch = ((input: string | URL | Request, init?: FetchInit) => {
    let url: URL;
    try { url = urlOf(input); } catch (error) { return Promise.reject(error); }
    if (init?.unix !== undefined || isLocalUrl(url)) return nativeFetch(input, init);
    return Promise.reject(refuse("other", url, `a direct connection to ${targetOf(url)} was refused: it did not go through the outbound proxy`));
  }) as typeof fetch;
  guardedFetch.preconnect = () => {};
  class GuardedWebSocket extends NativeWebSocket {
    constructor(address: string | URL, options?: unknown) {
      const url = new URL(String(address));
      if (!isLocalUrl(url)) throw refuse("other", url, `a direct connection to ${targetOf(url)} was refused: it did not go through the outbound proxy`);
      super(address, options as string[]);
    }
  }
  globalThis.fetch = guardedFetch;
  globalThis.WebSocket = GuardedWebSocket as typeof WebSocket;
  return () => {
    globalThis.fetch = nativeFetch;
    globalThis.WebSocket = NativeWebSocket;
  };
}
