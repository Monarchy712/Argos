/**
 * One stroke-based icon set, drawn on a 24px grid at 1.75 stroke so glyphs sit evenly next to
 * 11-13px monospace labels. Inline rather than a dependency: the app ships to Swarm as a static
 * collection and every byte is served from that collection.
 */
import type { SVGProps } from "react";

const P: Record<string, string> = {
  // nav
  overview: "M3 13h8V3H3v10Zm10 8h8V11h-8v10ZM3 21h8v-6H3v6ZM13 9h8V3h-8v6Z",
  contracts: "M4 5h16M4 12h16M4 19h16",
  add: "M12 5v14M5 12h14",
  how: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z",
  // chrome
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M18 6 6 18M6 6l12 12",
  chevronRight: "m9 18 6-6-6-6",
  chevronDown: "m6 9 6 6 6-6",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  copy: "M20 9H11a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2ZM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
  filter: "M22 3H2l8 9.5V19l4 2v-8.5L22 3Z",
  // status
  check: "m4 12.5 5 5 11-11",
  alert: "M12 3 2 20h20L12 3ZM12 9.5v5M12 17.5v.01",
  question: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.3 9.4a2.8 2.8 0 1 1 3.6 2.7c-.6.2-.9.7-.9 1.3v.6M12 17.2v.01",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16v-5M12 8v.01",
  minus: "M5 12h14",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z",
  shieldCheck: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z|m9 12 2 2 4-4",
  lock: "M5 11h14v10H5V11ZM8 11V7a4 4 0 0 1 8 0v4",
  // domain
  chain: "M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8",
  eye: "M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z|M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z",
  database: "M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3ZM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  cloud: "M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 10.3 3.5 3.5 0 0 0 6.5 19h11Z",
  cpu: "M6 6h12v12H6zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4",
  layers: "m12 2 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 17l9 5 9-5",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l3.5-7Z",
  spark: "M13 2 4 14h7l-1 8 9-12h-7l1-8Z",
};

export type IconName = keyof typeof P | string;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  const d = P[name] ?? P.info!;
  const filled = name === "alert";
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={filled ? 1.9 : 1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" {...rest}
    >
      {d.split("|").map((seg, i) => <path key={i} d={seg} />)}
    </svg>
  );
}
