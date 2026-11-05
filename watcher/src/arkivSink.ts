import type { Sink } from "./sink.ts";

/** Placeholder until Test 2 confirms the Arkiv write API; then this becomes the real sink. */
export const ArkivSink = {
  fromEnv(): Sink {
    throw new Error("Arkiv sink not implemented yet; use WATCHER_SINK=file");
  },
};
