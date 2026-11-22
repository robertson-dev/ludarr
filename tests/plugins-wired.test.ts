import { describe, expect, test } from "bun:test";
import { BUILTIN } from "../src/plugins/builtin";
import { definitionsOf } from "../src/plugins/types";

/** every settings field a built-in declares must be read by its implementation — no decorative options */
describe("built-in plugin settings are wired", () => {
  const files: Record<string, string> = {
    indexers: "src/plugins/builtin/indexers.ts", "download-clients": "src/plugins/builtin/clients.ts", catalog: "src/plugins/builtin/metadata.ts",
    importers: "src/plugins/builtin/importers.ts", runtimes: "src/plugins/builtin/runtimes.ts", notifications: "src/plugins/builtin/notifications.ts",
  };
  for (const p of BUILTIN) {
    test(`${p.id}: ${definitionsOf(p).length} definitions`, async () => {
      const src = await Bun.file(files[p.id]).text();
      const unread: string[] = [];
      for (const d of definitionsOf(p)) {
        for (const f of d.fields) {
          // a field is used when its name appears beyond its own declaration: s.name, s["name"], settings[...] — or is one of the event switches read by notify.ts
          const uses = src.match(new RegExp(`\\b${f.name}\\b`, "g"))?.length ?? 0;
          if (uses < 2) unread.push(`${d.impl}.${f.name}`);
        }
        expect(d.impl).toMatch(/^[a-z0-9-]+$/);
        for (const f of d.fields) { expect(f.label.length).toBeGreaterThan(0); if (f.type === "select") expect(f.options?.length).toBeGreaterThan(0); }
      }
      expect(unread).toEqual([]);
    });
  }
});
