/**
 * Shared primitives. Three rules hold everywhere in Argos and are enforced here rather than
 * remembered per screen:
 *
 *  1. A status is never colour alone. Every badge carries a glyph, a word and a border style.
 *  2. A status is never timeless. `<AsOf>` sits next to it with the block it was observed at.
 *  3. Chain data is monospace. Addresses, hashes, blocks and selectors never render in the UI face.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Status } from "@driftguard/core";
import { ARKIV_EXPLORER, CHAINS, SWARM_GATEWAY } from "../lib/config.ts";
import { Icon, type IconName } from "./icons.tsx";

export type Tone = "ok" | "bad" | "warn" | "info" | "neutral";

/* ------------------------------------------------------------------ status */

const STATUS: Record<Status, { tone: Tone; label: string; icon: IconName }> = {
  GREEN: { tone: "ok", label: "Verified", icon: "check" },
  RED: { tone: "bad", label: "Change detected", icon: "alert" },
  NOT_VERIFIED: { tone: "warn", label: "Not verified", icon: "question" },
};

const TONE_CLASS: Record<Tone, string> = { ok: "b-ok", bad: "b-bad", warn: "b-warn", info: "b-info", neutral: "" };

export function StatusBadge({ status, large }: { status: Status; large?: boolean }) {
  const s = STATUS[status];
  return (
    <span className={`badge ${TONE_CLASS[s.tone]}${large ? " lg" : ""}`} role="status">
      <Icon name={s.icon} size={large ? 16 : 13} />
      {s.label}
    </span>
  );
}

export function Badge({ tone = "neutral", icon, children, large }: { tone?: Tone; icon?: IconName; children: ReactNode; large?: boolean }) {
  return (
    <span className={`badge ${TONE_CLASS[tone]}${large ? " lg" : ""}`}>
      {icon && <Icon name={icon} size={large ? 16 : 13} />}
      {children}
    </span>
  );
}

export const statusTone = (s: Status): Tone => STATUS[s].tone;
export const statusLabel = (s: Status): string => STATUS[s].label;
/** `s-ok` / `s-bad` / `s-warn`, for the severity stripe on rows and cards. */
export const stripeClass = (s: Status) => `s-${STATUS[s].tone}`;

/**
 * The line that must accompany every status. A monitoring result is an observation at a block,
 * not a standing property of the contract, and the UI says so every single time.
 */
export function AsOf({ block, at, now, prefix = "as of" }: { block?: bigint | null; at?: number | null; now?: number; prefix?: string }) {
  if (block == null && at == null) return <span className="asof">no observation recorded</span>;
  return (
    <span className="asof">
      {prefix}{" "}
      {block != null && <>block <b>{block.toString()}</b></>}
      {block != null && at != null && " · "}
      {at != null && <>checked {ago(at, now)}</>}
    </span>
  );
}

/* --------------------------------------------------------------- addresses */

export const short = (v: string, head = 6, tail = 4) => (v && v.length > head + tail + 2 ? `${v.slice(0, head)}…${v.slice(-tail)}` : v);

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={`copy${done ? " done" : ""}`}
      aria-label={done ? `${label} copied` : `Copy ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void navigator.clipboard.writeText(value).then(
          () => {
            setDone(true);
            toast(`${label} copied`);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setDone(false), 1400);
          },
          () => toast("Clipboard unavailable"),
        );
      }}
    >
      <Icon name={done ? "check" : "copy"} size={12} />
    </button>
  );
}

export function AddressLink({
  chainId, address, full, tone, copy = true, head = 8, tail = 6,
}: { chainId: number; address: string; full?: boolean; tone?: "bad" | "ok" | "muted"; copy?: boolean; head?: number; tail?: number }) {
  const explorer = CHAINS[chainId]?.explorer;
  const text = full ? address : short(address, head, tail);
  return (
    <span className={`addr${tone ? ` ${tone}` : ""}`}>
      {explorer ? (
        <a className="val" href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer" title={address}>{text}</a>
      ) : (
        <span className="val" title={address}>{text}</span>
      )}
      {copy && <CopyButton value={address} label="Address" />}
    </span>
  );
}

export function TxLink({ chainId, tx, head = 10, tail = 8 }: { chainId: number; tx: string; head?: number; tail?: number }) {
  if (!tx) return <span className="dimmer t-12">found by slot read (no transaction)</span>;
  const explorer = CHAINS[chainId]?.explorer;
  return (
    <span className="addr">
      {explorer ? (
        <a className="val" href={`${explorer}/tx/${tx}`} target="_blank" rel="noreferrer" title={tx}>{short(tx, head, tail)}</a>
      ) : (
        <span className="val" title={tx}>{short(tx, head, tail)}</span>
      )}
      <CopyButton value={tx} label="Transaction hash" />
    </span>
  );
}

export function ArkivLink({ entityKey, label = "Arkiv record" }: { entityKey: string; label?: string }) {
  return (
    <a className="addr" href={`${ARKIV_EXPLORER}/entity/${entityKey}`} target="_blank" rel="noreferrer" title={`Arkiv entity ${entityKey}`}>
      <span className="val">{label}</span>
      <Icon name="external" size={11} />
    </a>
  );
}

export function SwarmLink({ swarmRef, label = "Swarm content" }: { swarmRef: string; label?: string }) {
  return (
    <a className="addr" href={`${SWARM_GATEWAY}/bytes/${swarmRef}`} target="_blank" rel="noreferrer" title={`Swarm reference ${swarmRef}`}>
      <span className="val">{label}</span>
      <Icon name="external" size={11} />
    </a>
  );
}

export const chainName = (id: number) => CHAINS[id]?.name ?? `chain ${id}`;

export function ago(unixSeconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - unixSeconds));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/* ------------------------------------------------------------------ layout */

export function Card({ children, className = "", stripe }: { children: ReactNode; className?: string; stripe?: Tone }) {
  return <div className={`card${stripe ? ` striped s-${stripe}` : ""} ${className}`}>{children}</div>;
}

export function CardHead({ title, sub, actions, icon }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; icon?: IconName }) {
  return (
    <div className="card-head">
      {icon && <Icon name={icon} size={16} style={{ color: "var(--muted)" }} />}
      <div className="grow">
        <div className="sec-title">{title}</div>
        {sub && <div className="sec-sub" style={{ marginTop: 2 }}>{sub}</div>}
      </div>
      {actions}
    </div>
  );
}

export function Metric({ label, value, note, tone, tip }: { label: string; value: ReactNode; note?: ReactNode; tone?: Tone; tip?: string }) {
  return (
    <div className={`card metric striped${tone ? ` s-${tone}` : ""}`}>
      <div className="m-label">
        <span className="eyebrow">{label}</span>
        {tip && <Tip text={tip} />}
      </div>
      <div className="m-value">{value}</div>
      {note && <div className="m-note">{note}</div>}
    </div>
  );
}

export function Tip({ text }: { text: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);

  /**
   * The body is centred on the trigger, so a tip near either page edge hangs off it — at 375px
   * a 268px body beside a label 114px in was clipped by 20px. Measure when it opens and shift it
   * back by however much it overhangs. Fail-open: if this never runs the tip is still centred and
   * readable, just closer to the edge, so an explanation is never withheld.
   */
  const clamp = useCallback(() => {
    const body = ref.current?.querySelector<HTMLElement>(".tip-body");
    if (!body) return;
    body.style.setProperty("--tip-shift", "0px");
    const r = body.getBoundingClientRect();
    const edge = 8;
    const shift =
      r.left < edge ? edge - r.left
      : r.right > window.innerWidth - edge ? window.innerWidth - edge - r.right
      : 0;
    if (shift) body.style.setProperty("--tip-shift", `${Math.round(shift)}px`);
  }, []);

  return (
    <span className="tip" ref={ref} onPointerEnter={clamp} onFocusCapture={clamp}>
      <button type="button" className="tip-trigger" aria-label="What this means">?</button>
      <span className="tip-body" role="tooltip">{text}</span>
    </span>
  );
}

export function Callout({ tone = "neutral", icon, children }: { tone?: Tone | "accent"; icon?: IconName; children: ReactNode }) {
  const cls = tone === "accent" ? "c-accent" : tone === "neutral" ? "" : `c-${tone}`;
  const fallback: IconName = tone === "bad" ? "alert" : tone === "warn" ? "question" : tone === "ok" ? "check" : "info";
  return (
    <div className={`callout ${cls}`}>
      <Icon name={icon ?? fallback} size={15} />
      <div>{children}</div>
    </div>
  );
}

/** The AI disclaimer. Deliberately the same plain component on every surface that shows model output. */
export function AiNote() {
  return (
    <div className="ai-note">
      <Icon name="info" size={12} />
      <span>AI-generated explanations are informational and are not a security audit or a security verdict.</span>
    </div>
  );
}

export function Empty({ icon = "inbox", title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="e-glyph"><Icon name={icon} size={22} /></div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="stack-s" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={`sk h-14 ${i === lines - 1 ? "w-60" : i % 2 ? "w-80" : ""}`} />
      ))}
    </div>
  );
}

export function SkeletonRows({ rows = 4, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r}>
          <td className="stripe"><span /></td>
          {Array.from({ length: cols }, (_, c) => (
            <td key={c}><div className={`sk h-14 ${c === 0 ? "w-80" : "w-60"}`} /></td>
          ))}
        </tr>
      ))}
    </>
  );
}

/* ---------------------------------------------- the signature comparison rail
   Baseline on the left, observation on the right, the verdict in the gutter. The same component
   serves the contract overview, the investigation view and the guard, so the mental model never
   has to be relearned. */

export function Compare({
  tone, glyph, verdict, left, right,
}: {
  tone: Tone;
  glyph: IconName;
  verdict: ReactNode;
  left: { title: string; sub?: ReactNode; body: ReactNode };
  right: { title: string; sub?: ReactNode; body: ReactNode };
}) {
  return (
    <div className={`compare v-${tone}`}>
      <div className="compare-side">
        <div className="side-head">
          <span className="eyebrow">{left.title}</span>
          <Tip text="The implementation you reviewed and chose to trust. Argos never sets this for you." />
        </div>
        {left.sub}
        {left.body}
      </div>
      <div className="compare-gutter">
        <div className="verdict-glyph"><Icon name={glyph} size={19} /></div>
        {verdict}
      </div>
      <div className="compare-side">
        <div className="side-head">
          <span className="eyebrow">{right.title}</span>
          <Tip text="What the watcher last read from the chain, with the block it read at." />
        </div>
        {right.sub}
        {right.body}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- hooks */


/** Re-render every `ms` so time-based status (staleness) stays honest without new data. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * Scroll-triggered reveal. One shared IntersectionObserver rather than one per element, and it
 * opts out entirely under prefers-reduced-motion so the content is simply present — a monitoring
 * screen must never withhold a status because an animation has not run.
 */
let revealObserver: IntersectionObserver | null = null;
function getRevealObserver() {
  revealObserver ??= new IntersectionObserver(
    (entries, obs) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          obs.unobserve(e.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
  );
  return revealObserver;
}

export function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;

    // Hide only now that we know we can un-hide: `armed` carries the hidden state.
    el.classList.add("armed");
    const obs = getRevealObserver();
    obs.observe(el);

    // Backstop. A tab that is not compositing (hidden pane, background tab, some headless
    // contexts) can leave the observer silent *and* freeze an already-started transition at its
    // start value — so merely dropping `armed` is not enough, because an in-flight transition
    // keeps supplying opacity 0. Land the element with inline styles that cancel the transition
    // outright. Content is never withheld because an animation could not run.
    const t = window.setTimeout(() => {
      el.classList.remove("armed");
      el.style.transition = "none";
      el.style.opacity = "1";
      el.style.transform = "none";
    }, 1400);
    return () => {
      window.clearTimeout(t);
      obs.unobserve(el);
    };
  }, []);
  return (
    <div ref={ref} className={`reveal ${className}`} style={delay ? { transitionDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  );
}

/** A dot that breathes only where the data behind it really is live. */
export function LiveDot({ tone = "ok", idle }: { tone?: Tone; idle?: boolean }) {
  const cls = idle ? "d-idle" : tone === "ok" ? "" : `d-${tone === "neutral" ? "idle" : tone}`;
  return <span className={`live-dot ${cls}`} aria-hidden />;
}

/** Close on outside click or Escape — used by the header menus. */
export function useDismiss<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return ref;
}

/* ------------------------------------------------------------------ toasts */

let toastId = 0;
const toastListeners = new Set<() => void>();
let toasts: { id: number; text: string }[] = [];

export function toast(text: string) {
  const id = ++toastId;
  toasts = [...toasts, { id, text }];
  toastListeners.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    toastListeners.forEach((l) => l());
  }, 2000);
}

export function Toasts() {
  const items = useSyncExternalStore(
    useCallback((cb: () => void) => {
      toastListeners.add(cb);
      return () => toastListeners.delete(cb);
    }, []),
    () => toasts,
    () => toasts,
  );
  if (!items.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div className="toast" key={t.id}>
          <Icon name="check" size={13} />
          {t.text}
        </div>
      ))}
    </div>
  );
}
