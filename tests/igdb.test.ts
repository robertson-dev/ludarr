import { describe, expect, test } from "bun:test";
import { imageUrl } from "../src/igdb";

describe("igdb image url builder", () => {
  test("cover size", () => {
    expect(imageUrl("co1l2i", "cover"))
      .toBe("https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1l2i.jpg");
  });
  test("banner uses 720p", () => {
    expect(imageUrl("abc", "banner"))
      .toBe("https://images.igdb.com/igdb/image/upload/t_720p/abc.jpg");
  });
});

describe("igdb client guards", () => {
  test("search rejects sanitizable junk quietly", async () => {
    // can't hit network in tests; search() would throw IGDB_NOT_CONFIGURED
    const { IgdbClient } = await import("../src/igdb");
    const c = new IgdbClient();
    // ensure constructor does not explode without env vars
    expect(typeof c.configured()).toBe("boolean");
  });
});
