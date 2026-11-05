import { join } from "node:path";
import type { WatcherConfig } from "./config.ts";
import { FileSink, type Sink } from "./sink.ts";

/** Builds the configured sink. The Arkiv sink is loaded lazily so file mode needs no keys. */
export async function makeSink(config: WatcherConfig): Promise<Sink> {
  if (config.sink === "file") return new FileSink(join(config.stateDir, "file-sink.json"));
  const { ArkivSink } = await import("./arkivSink.ts");
  return ArkivSink.fromEnv();
}
