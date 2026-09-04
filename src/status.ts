/**
 * Live status of a running tgfx, kept apart from the log.
 *
 * The app emits small typed events; the store folds them into one snapshot
 * the terminal view renders. Everything here is plain data so the view can
 * be tested from events alone.
 */

import type { OutputMode } from "./types";

export type RouteLabel = {
  key: string;
  /** What a person recognises: the sender's name in a private chat, the chat title in a group. */
  chat: string;
  group: boolean;
};

/** One glyph per ACP event; forty of them tell the story of a turn. */
export type TraceGlyph = "⋯" | "·" | "▪" | "▫" | "✗" | "!" | "✂";

export type StatusEvent =
  | { type: "poll"; state: "listening" }
  | { type: "poll"; state: "reconnecting"; retryMs: number }
  | { type: "inbound"; route: RouteLabel; who: string }
  | { type: "queue"; route: RouteLabel; waiting: number }
  | { type: "session"; route: RouteLabel; state: "starting" | "gone" }
  | { type: "session"; route: RouteLabel; state: "ready"; model?: string }
  /** The route's session switched model, from the picker in Telegram. */
  | { type: "model"; route: RouteLabel; model: string }
  /** Startup progress; the wire assembles itself from these until polling reports in. */
  | { type: "boot"; step: BootStep; state: "running" | "done" | "failed"; detail?: string }
  | { type: "turn"; route: RouteLabel; state: "started"; who: string; text: string }
  | { type: "turn"; route: RouteLabel; state: "event"; glyph: TraceGlyph }
  | { type: "turn"; route: RouteLabel; state: "waiting"; waiting: boolean }
  | { type: "turn"; route: RouteLabel; state: "finished"; outcome: "delivered" | "cancelled" | "failed"; seconds: number }
  | { type: "settings"; settings: Partial<Settings> };

export type BootStep = "fx" | "telegram" | "lock" | "menus" | "polling";
export const BOOT_STEPS: BootStep[] = ["fx", "telegram", "lock", "menus", "polling"];
export type BootState = { state: "pending" | "running" | "done" | "failed"; detail?: string };

export type Settings = { output: OutputMode; customIcons: boolean; paused: boolean; yolo: boolean };

export type RouteStatus = RouteLabel & {
  who: string;
  text: string;
  trace: TraceGlyph[];
  startedAt: number;
  lastGlyphAt: number;
  waiting: boolean;
  queued: number;
  session: "off" | "starting" | "ready";
  /** The session's model, once its ACP handshake or a picker change reported it. */
  model?: string;
  turn: "idle" | "running";
  finished?: { outcome: "delivered" | "cancelled" | "failed"; seconds: number; at: number };
};

/** A label sliding along the wire; the view derives its position from age. */
export type Packet = { at: number; label: string; segment: "left" | "right"; direction: "in" | "out" };

export type LogLine = { at: number; text: string };

export type StatusSnapshot = {
  poll: { state: "listening" | "reconnecting"; retryMs: number; since: number };
  /** Undefined once startup is over, or when no boot events were ever reported. */
  boot?: { steps: Record<BootStep, BootState>; since: number; bot?: string };
  /** The bot's handle once the token is validated. */
  bot?: string;
  routes: RouteStatus[];
  packets: Packet[];
  settings: Settings;
  log: LogLine[];
};

const TRACE_LENGTH = 40;
/** Consecutive glyphs of the same kind merge unless this much time passed. */
const GLYPH_MERGE_MS = 800;
const PACKET_TTL_MS = 2_500;
const LOG_LINES = 200;

export class StatusStore {
  private readonly routes = new Map<string, RouteStatus>();
  private packets: Packet[] = [];
  private poll: StatusSnapshot["poll"];
  private settings: Settings;
  private bot?: string;
  private boot?: { steps: Record<BootStep, BootState>; since: number };
  private log: LogLine[] = [];
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(
    settings: Partial<Settings> = {},
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.settings = { output: "live", customIcons: true, paused: false, yolo: false, ...settings };
    this.poll = { state: "listening", retryMs: 0, since: this.clock() };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Changes on every event; a cheap key for React to compare. */
  get revision(): number {
    return this.version;
  }

  apply(event: StatusEvent): void {
    const now = this.clock();
    switch (event.type) {
      case "poll":
        this.poll = { state: event.state, retryMs: event.state === "reconnecting" ? event.retryMs : 0, since: now };
        break;
      case "inbound":
        this.packets.push({ at: now, label: `▶ ${event.who}`, segment: "left", direction: "in" });
        break;
      case "queue":
        this.route(event.route).queued = event.waiting;
        break;
      case "session": {
        const route = this.route(event.route);
        route.session = event.state === "gone" ? "off" : event.state;
        if (event.state === "ready" && event.model) route.model = event.model;
        break;
      }
      case "model":
        this.route(event.route).model = event.model;
        break;
      case "boot": {
        this.boot ??= {
          since: now,
          steps: Object.fromEntries(BOOT_STEPS.map((step) => [step, { state: "pending" }])) as Record<BootStep, BootState>,
        };
        this.boot.steps[event.step] = { state: event.state, ...(event.detail ? { detail: event.detail } : {}) };
        if (event.step === "telegram" && event.state === "done" && event.detail) this.bot = event.detail;
        if (event.step === "polling" && event.state === "done") this.boot = undefined;
        break;
      }
      case "turn": {
        const previous = this.routes.get(event.route.key);
        const labelChanged = previous?.chat !== event.route.chat || previous?.group !== event.route.group;
        const route = this.route(event.route);
        if (event.state === "started") {
          Object.assign(route, {
            who: event.who, text: event.text, trace: [], startedAt: now, lastGlyphAt: 0,
            waiting: false, turn: "running", finished: undefined, session: "ready",
          });
          this.packets.push({ at: now, label: `▶ ${event.who}`, segment: "right", direction: "in" });
        } else if (event.state === "event") {
          const last = route.trace.at(-1);
          if (last === event.glyph && now - route.lastGlyphAt < GLYPH_MERGE_MS) {
            if (!labelChanged) return;
            break;
          }
          route.trace.push(event.glyph);
          if (route.trace.length > TRACE_LENGTH) route.trace.splice(0, route.trace.length - TRACE_LENGTH);
          route.lastGlyphAt = now;
        } else if (event.state === "waiting") {
          route.waiting = event.waiting;
        } else {
          route.turn = "idle";
          route.waiting = false;
          route.finished = { outcome: event.outcome, seconds: event.seconds, at: now };
          if (event.outcome === "cancelled") route.trace.push("✂");
          this.packets.push({
            at: now, segment: "right", direction: "out",
            label: event.outcome === "delivered" ? "◀ ✓" : event.outcome === "cancelled" ? "◀ ✂" : "◀ ✗",
          });
        }
        break;
      }
      case "settings":
        this.settings = { ...this.settings, ...event.settings };
        break;
    }
    this.bump();
  }

  /** Log lines live here so the view can show a tail on demand. */
  logLine(text: string): void {
    this.log.push({ at: this.clock(), text });
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES);
    this.bump();
  }

  snapshot(): StatusSnapshot {
    const now = this.clock();
    this.packets = this.packets.filter((packet) => now - packet.at < PACKET_TTL_MS);
    return {
      poll: this.poll,
      ...(this.boot ? { boot: { ...this.boot, steps: { ...this.boot.steps } } } : {}),
      ...(this.bot ? { bot: this.bot } : {}),
      routes: [...this.routes.values()],
      packets: [...this.packets],
      settings: this.settings,
      log: [...this.log],
    };
  }

  private route(label: RouteLabel): RouteStatus {
    let route = this.routes.get(label.key);
    if (!route) {
      route = {
        ...label, who: "", text: "", trace: [], startedAt: 0, lastGlyphAt: 0,
        waiting: false, queued: 0, session: "off", turn: "idle",
      };
      this.routes.set(label.key, route);
    }
    route.chat = label.chat;
    route.group = label.group;
    return route;
  }

  private bump(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

/** Age of a packet as a 0..1 position along its segment, in travel direction. */
export function packetProgress(packet: Packet, now: number, travelMs = 1_200): number {
  return Math.min(1, Math.max(0, (now - packet.at) / travelMs));
}
