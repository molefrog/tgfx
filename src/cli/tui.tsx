import { Box, render, Text, useInput, useStdout } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  BOOT_STEPS,
  packetProgress,
  type BootStep,
  type Packet,
  type RouteStatus,
  type StatusSnapshot,
  type StatusStore,
  type TraceGlyph,
} from "../status";
import { OUTPUT_MODES, type OutputMode } from "../types";

/**
 * The live wire: `telegram ── tgfx ── fx` as the status view.
 *
 * Three lines, redrawn in place. The left segment shows polling health, the
 * right one the ACP link, packets slide along both, and each route gets one
 * line with its turn compressed to a glyph trace. Finished lines stay for a
 * day so the recent conversations are visible. Logs stay hidden until `l`
 * opens a tail beneath.
 */

export type TuiControls = {
  quit(): void;
  setOutput(output: OutputMode): void;
  setCustomIcons(on: boolean): void;
  setPaused(on: boolean): void;
};

export type TuiProps = {
  store: StatusStore;
  controls: TuiControls;
  columns?: number;
  now?: () => number;
  /** Off in tests: no timers, the frame is a pure function of the store. */
  animate?: boolean;
};

const MAX_ROUTE_LINES = 5;
/** A finished turn keeps its line this long, then folds into the idle summary. */
const RECENT_MS = 24 * 3_600_000;
const LOG_TAIL = 8;
const SPINNER = ["◐", "◓", "◑", "◒"];
const TRACE_COLOR: Record<TraceGlyph, string | undefined> = {
  "⋯": "cyan", "·": "cyan", "▪": "magenta", "▫": undefined, "✗": "red", "!": "yellow", "✂": "yellow",
};

type Cell = { ch: string; color?: string; dim?: boolean; bold?: boolean };

function cells(text: string, style: Omit<Cell, "ch"> = {}): Cell[] {
  return [...text].map((ch) => ({ ch, ...style }));
}

function overlay(track: Cell[], packet: Packet, now: number): void {
  const label = [...packet.label];
  const progress = packetProgress(packet, now);
  const span = Math.max(0, track.length - label.length);
  const start = Math.round(packet.direction === "in" ? progress * span : (1 - progress) * span);
  label.forEach((ch, index) => {
    if (start + index < track.length) track[start + index] = { ch, color: index === 0 ? "cyan" : undefined, bold: index > 0 };
  });
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function Cells({ cells: list }: { cells: Cell[] }) {
  // Merge runs with the same style so Ink gets a handful of spans, not one per column.
  const runs: Array<Cell & { text: string }> = [];
  for (const cell of list) {
    const last = runs.at(-1);
    if (last && last.color === cell.color && last.dim === cell.dim && last.bold === cell.bold) last.text += cell.ch;
    else runs.push({ ...cell, text: cell.ch });
  }
  return (
    <Text wrap="truncate-end">
      {runs.map((run, index) => (
        <Text key={index} color={run.color} dimColor={run.dim} bold={run.bold}>{run.text}</Text>
      ))}
    </Text>
  );
}

function Wire({ store, columns, now, tick }: { store: StatusStore; columns: number; now: number; tick: number }) {
  const { poll, routes, packets, settings, boot, bot } = store.snapshot();
  const left = `${bot ?? "telegram"} `;
  const middle = " tgfx ";
  const right = " fx";
  const running = routes.filter((route) => route.turn === "running");
  const suffix = running.length > 1 ? ` ×${running.length}` : "";
  const fixed = [...left].length + 1 + [...middle].length + 1 + 1 + [...right].length + [...suffix].length;
  const usable = Math.max(40, Math.min(columns, 100) - fixed);
  const leftWidth = Math.round(usable * 0.45);
  const rightWidth = usable - leftWidth;
  const spinner = SPINNER[tick % SPINNER.length]!;

  if (boot) {
    // Startup: the wire assembles from tgfx outwards as each check comes back.
    const { fx, telegram, lock } = boot.steps;
    const node = (step: { state: string }, ready: Cell): Cell =>
      step.state === "done" ? ready
        : step.state === "failed" ? { ch: "✕", color: "red" }
          : step.state === "running" ? { ch: spinner, color: "yellow" }
            : { ch: "○", dim: true };
    const track = (step: { state: string; detail?: string }, width: number): Cell[] =>
      step.state === "failed"
        ? centered(width, ` ✕ ${step.detail ?? "failed"} `, "╌", { color: "red" })
        : cells("┈".repeat(width), { dim: true });
    return (
      <Cells cells={[
        ...cells(left, { dim: true }),
        node(telegram, { ch: "●", color: "green" }),
        ...track(telegram, leftWidth),
        ...cells(middle, { bold: lock.state === "done", dim: lock.state !== "done" }),
        ...track(fx, rightWidth),
        { ch: " " },
        node(fx, { ch: "●", dim: true }),
        ...cells(right, { dim: fx.state !== "done", bold: fx.state === "done" }),
      ]} />
    );
  }

  let leftTrack: Cell[];
  let leftNode: Cell;
  if (settings.paused) {
    leftNode = { ch: "○", dim: true };
    leftTrack = centered(leftWidth, " ⏸ paused ", "─", { dim: true });
  } else if (poll.state === "reconnecting") {
    const remaining = Math.max(0, Math.ceil((poll.retryMs - (now - poll.since)) / 1_000));
    leftNode = { ch: "○", color: "yellow" };
    leftTrack = centered(leftWidth, ` ✕ retry ${remaining}s `, "╌", { color: "yellow" });
  } else {
    leftNode = { ch: "●", color: "green" };
    leftTrack = Array.from({ length: leftWidth }, (_, index) =>
      (index - tick) % 7 === 0 ? { ch: "·", color: "cyan" } : { ch: "─", dim: true });
  }
  for (const packet of packets) if (packet.segment === "left") overlay(leftTrack, packet, now);

  const sessions = routes.filter((route) => route.session !== "off");
  const starting = routes.some((route) => route.session === "starting");
  const waiting = running.some((route) => route.waiting);
  const rightTrack: Cell[] = Array.from({ length: rightWidth }, (_, index) => {
    if (!sessions.length) return { ch: "┈", dim: true };
    if (running.length && (index + tick) % 7 === 0) return { ch: "·", color: "magenta" };
    return { ch: "─", dim: true };
  });
  for (const packet of packets) if (packet.segment === "right") overlay(rightTrack, packet, now);
  const fxNode: Cell = waiting
    ? { ch: "!", color: "yellow" }
    : running.length
      ? { ch: SPINNER[tick % SPINNER.length]!, color: "magenta" }
      : starting
        ? { ch: "◌", color: "yellow" }
        : sessions.length
          ? { ch: "●", color: "green" }
          : { ch: "●", dim: true };

  return (
    <Cells cells={[
      ...cells(left, { dim: true }),
      leftNode,
      ...leftTrack,
      ...cells(middle, { bold: true }),
      ...rightTrack,
      { ch: " " },
      fxNode,
      ...cells(right, { dim: !sessions.length, bold: sessions.length > 0 }),
      ...cells(suffix, { color: "magenta" }),
    ]} />
  );
}

function centered(width: number, label: string, fill: string, style: Omit<Cell, "ch">): Cell[] {
  const chars = [...label];
  const pad = Math.max(0, width - chars.length);
  const before = Math.floor(pad / 2);
  return [
    ...cells(fill.repeat(before), style),
    ...chars.slice(0, width).map((ch) => ({ ch, ...style })),
    ...cells(fill.repeat(pad - before), style),
  ];
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h`;
}

function RouteLine({ route, now }: { route: RouteStatus; now: number }) {
  const seconds = Math.floor((now - route.startedAt) / 1_000);
  const tools = route.trace.filter((glyph) => glyph === "▫" || glyph === "✗").length;
  return (
    <Box>
      <Text>{"  "}</Text>
      <Text bold>{route.chat}</Text>
      {route.group && <Text dimColor>{" › "}</Text>}
      {route.group && <Text bold>{route.who}</Text>}
      <Text dimColor>{`  ${truncate(route.text, 36)}  `}</Text>
      <Text>
        {route.trace.map((glyph, index) => (
          <Text key={index} color={TRACE_COLOR[glyph]} dimColor={TRACE_COLOR[glyph] === undefined}>{glyph}</Text>
        ))}
      </Text>
      <Box flexGrow={1} />
      {route.finished
        ? <Text dimColor>
            {"  "}
            <Text color={OUTCOME_COLOR[route.finished.outcome]}>{route.finished.outcome}</Text>
            {` · ${route.finished.seconds}s · ${tools} ${tools === 1 ? "tool" : "tools"} · ${ago(now - route.finished.at)} ago`}
          </Text>
        : route.waiting
        ? <Text color="yellow">{`  ⚑ approval  ${seconds}s`}</Text>
        : <Text dimColor>{`  ${seconds}s · ${tools} ${tools === 1 ? "tool" : "tools"}`}</Text>}
      {route.model && <Text dimColor>{` · ${route.model}`}</Text>}
      {route.queued > 0 && <Text color="yellow">{`  +${route.queued} waiting`}</Text>}
    </Box>
  );
}

const OUTCOME_COLOR: Record<NonNullable<RouteStatus["finished"]>["outcome"], string | undefined> = {
  delivered: undefined, cancelled: "yellow", failed: "red",
};

const BOOT_LABEL: Record<BootStep, { doing: string; done: string }> = {
  fx: { doing: "checking fx", done: "fx" },
  telegram: { doing: "validating bot token", done: "bot" },
  lock: { doing: "acquiring lock", done: "lock" },
  menus: { doing: "installing menus", done: "menus" },
  polling: { doing: "starting polling", done: "polling" },
};

/** A checklist that overwrites itself: finished steps, the running one, elapsed time. */
function BootLine({ boot, now }: { boot: NonNullable<StatusSnapshot["boot"]>; now: number }) {
  const parts: string[] = ["starting"];
  for (const step of BOOT_STEPS) {
    const { state, detail } = boot.steps[step];
    if (state === "done") parts.push(`${BOOT_LABEL[step].done} ✓`);
    else if (state === "running") parts.push(BOOT_LABEL[step].doing);
    else if (state === "failed") parts.push(`${BOOT_LABEL[step].done} ✕${detail ? ` ${detail}` : ""}`);
  }
  const failed = BOOT_STEPS.some((step) => boot.steps[step].state === "failed");
  return (
    <Text dimColor={!failed} color={failed ? "red" : undefined}>
      {`  ${parts.join(" · ")}  ${((now - boot.since) / 1_000).toFixed(1)}s`}
    </Text>
  );
}

function Routes({ store, now }: { store: StatusStore; now: number }) {
  const { routes, boot } = store.snapshot();
  if (boot) return <BootLine boot={boot} now={now} />;
  const running = routes.filter((route) => route.turn === "running").sort((a, b) => a.startedAt - b.startedAt);
  const recent = routes
    .filter((route) => route.turn !== "running" && route.finished && now - route.finished.at < RECENT_MS)
    .sort((a, b) => b.finished!.at - a.finished!.at);
  const lines = [...running, ...recent];
  if (lines.length) {
    return (
      <Box flexDirection="column">
        {lines.slice(0, MAX_ROUTE_LINES).map((route) => <RouteLine key={route.key} route={route} now={now} />)}
        {lines.length > MAX_ROUTE_LINES && <Text dimColor>{`  +${lines.length - MAX_ROUTE_LINES} more`}</Text>}
      </Box>
    );
  }
  const sessions = routes.filter((route) => route.session !== "off").length;
  const last = routes.filter((route) => route.finished).sort((a, b) => b.finished!.at - a.finished!.at)[0];
  const sessionText = `${sessions} ${sessions === 1 ? "session" : "sessions"}`;
  if (!last?.finished) return <Text dimColor>{`  idle · ${sessionText} · waiting for a message`}</Text>;
  const tools = last.trace.filter((glyph) => glyph === "▫" || glyph === "✗").length;
  return (
    <Text dimColor>
      {`  idle · ${sessionText} · last `}
      <Text bold>{last.who}</Text>
      {` ${ago(now - last.finished.at)} ago · ${last.finished.outcome} · ${last.finished.seconds}s · ${tools} ${tools === 1 ? "tool" : "tools"}`}
      {last.model ? ` · ${last.model}` : ""}
    </Text>
  );
}

function Switch({ hotkey, name, on, readOnly }: { hotkey: string; name: string; on: boolean; readOnly?: boolean }) {
  return (
    <Text>
      {"  "}
      <Text color="cyan">{hotkey}</Text>
      <Text dimColor={readOnly}>{` ${name} `}</Text>
      <Text color={on ? "green" : undefined} dimColor={!on}>{on ? "●" : "○"}</Text>
    </Text>
  );
}

function PatchBay({ store, showLog, menuOpen }: { store: StatusStore; showLog: boolean; menuOpen: boolean }) {
  const { settings } = store.snapshot();
  return (
    <Box>
      <Text>
        {"  "}
        <Text color="cyan">f</Text>
        <Text bold={menuOpen}>{" format"}</Text>
        <Text dimColor>{menuOpen ? " ▾" : "  "}</Text>
      </Text>
      <Switch hotkey="p" name="pause" on={settings.paused} />
      <Switch hotkey="l" name="log" on={showLog} />
      <Box flexGrow={1} />
      {settings.yolo && <Text><Text color="yellow">✓</Text><Text dimColor>{" yolo  "}</Text></Text>}
      <Text dimColor>q quit  </Text>
    </Box>
  );
}

const OUTPUT_HINT: Record<OutputMode, string> = {
  answer: "one message with just the answer",
  report: "one message: the answer, then what fx did",
  progress: "live status line, then the answer streams in",
  live: "live draft with every tool call",
};

/**
 * How answers look in Telegram. Values show only while the menu is open; each
 * option cycles through its values, so a switch is a two-value select.
 */
type FormatOption = {
  name: string;
  value: string;
  values: readonly string[];
  /** How the value reads in the menu; dim when it means "off". */
  label: string;
  on: boolean;
  hint: string;
  set(value: string): void;
};

function formatOptions(store: StatusStore, controls: TuiControls): FormatOption[] {
  const { settings } = store.snapshot();
  return [
    {
      name: "output", value: settings.output, values: OUTPUT_MODES, label: settings.output, on: true,
      hint: OUTPUT_HINT[settings.output],
      set: (value) => controls.setOutput(value as OutputMode),
    },
    {
      name: "icons", value: settings.customIcons ? "on" : "off", values: ["on", "off"],
      label: settings.customIcons ? "● on" : "○ off", on: settings.customIcons,
      hint: "custom emoji on tool rows and pickers",
      set: (value) => controls.setCustomIcons(value === "on"),
    },
  ];
}

/** The value after the current one, wrapping; `step` -1 goes back. */
function cycle(option: FormatOption, step: 1 | -1): string {
  const current = option.values.indexOf(option.value);
  return option.values[(current + step + option.values.length) % option.values.length]!;
}

function FormatMenu({ options, cursor }: { options: FormatOption[]; cursor: number }) {
  return (
    <Box flexDirection="column">
      {options.map((option, index) => (
        <Box key={option.name}>
          <Text color="cyan">{index === cursor ? "    ▸ " : "      "}</Text>
          <Text bold={index === cursor}>{option.name.padEnd(9)}</Text>
          <Text color={option.on ? "green" : undefined} dimColor={!option.on}>{option.label.padEnd(9)}</Text>
          <Text dimColor>{`  ${option.hint}`}</Text>
        </Box>
      ))}
      <Text dimColor>{"      ↑↓ move · ←→ change · esc close"}</Text>
    </Box>
  );
}

function LogTail({ store }: { store: StatusStore }) {
  const { log } = store.snapshot();
  const lines = log.slice(-LOG_TAIL);
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.length === 0 && <Text dimColor>  no log lines yet</Text>}
      {lines.map((line) => (
        <Text key={line.at + line.text} dimColor wrap="truncate-end">
          {`  ${new Date(line.at).toTimeString().slice(0, 8)}  ${line.text}`}
        </Text>
      ))}
    </Box>
  );
}

export function Tui({ store, controls, columns, now = Date.now, animate = false }: TuiProps) {
  useSyncExternalStore((listener) => store.subscribe(listener), () => store.revision);
  const [tick, setTick] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const [menu, setMenu] = useState<{ open: boolean; cursor: number }>({ open: false, cursor: 0 });
  const { stdout } = useStdout();
  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setTick((value) => value + 1), 125);
    return () => clearInterval(timer);
  }, [animate]);
  const options = formatOptions(store, controls);
  useInput((input, key) => {
    const { settings } = store.snapshot();
    if (input === "q" || (key.ctrl && input === "c")) controls.quit();
    else if (input === "p") controls.setPaused(!settings.paused);
    else if (input === "l") setShowLog((value) => !value);
    else if (input === "f" || (menu.open && key.escape)) setMenu((state) => ({ ...state, open: !state.open }));
    else if (menu.open && key.upArrow) setMenu((state) => ({ ...state, cursor: Math.max(0, state.cursor - 1) }));
    else if (menu.open && key.downArrow) {
      setMenu((state) => ({ ...state, cursor: Math.min(options.length - 1, state.cursor + 1) }));
    } else if (menu.open && (input === " " || key.return || key.rightArrow || key.leftArrow)) {
      const option = options[menu.cursor];
      if (option) option.set(cycle(option, key.leftArrow ? -1 : 1));
    }
  });
  const width = columns ?? stdout.columns ?? 80;
  const current = now();
  return (
    <Box flexDirection="column" width={Math.min(width, 100)}>
      <Wire store={store} columns={width} now={current} tick={tick} />
      <Routes store={store} now={current} />
      <PatchBay store={store} showLog={showLog} menuOpen={menu.open} />
      {menu.open && <FormatMenu options={options} cursor={menu.cursor} />}
      {showLog && <LogTail store={store} />}
    </Box>
  );
}

/** Mounts the view on stderr so stdout stays clean for `--json` style output. */
export function startTui(props: Omit<TuiProps, "animate">): { unmount(): void } {
  const instance = render(<Tui {...props} animate />, {
    stdout: process.stderr,
    stdin: process.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { unmount: () => instance.unmount() };
}
