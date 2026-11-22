import type { ContentPlan } from "../src/ways/types";

/** These tests put title-specific identifiers and conversion rules on the way. Its parent is a general emulator. */
export function generalTemplate(c: ContentPlan): ContentPlan {
  return { kind: c.kind, platform: c.platform, what: `a ${c.platform} game`, search: [c.platform],
    accept: { hashes: [], formats: c.accept.formats }, marker: c.marker, place: "games/{name}" };
}
