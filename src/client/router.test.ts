import { describe, expect, it } from "vitest";
import { parseRoute } from "./router";

describe("parseRoute", () => {
  it("SPEC.md の URL を読み分ける", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute("/p/2026-01-12-book-a")).toEqual({ kind: "page", name: "2026-01-12-book-a" });
    expect(parseRoute("/p/%E6%9E%B6%E7%A9%BA%20%E5%A4%AA%E9%83%8E")).toEqual({ kind: "page", name: "架空 太郎" });
    expect(parseRoute("/all", "?q=a%20b")).toEqual({ kind: "all", q: "a b" });
    expect(parseRoute("/new", "?title=T&body=B")).toEqual({ kind: "new", title: "T", body: "B" });
    expect(parseRoute("/append", "?page=P&body=B")).toEqual({ kind: "append", page: "P", body: "B" });
  });

  it("空の name と壊れたエンコードと知らないパスは unknown", () => {
    expect(parseRoute("/p/")).toEqual({ kind: "unknown", path: "/p/" });
    expect(parseRoute("/p/%E0%A4%A")).toEqual({ kind: "unknown", path: "/p/%E0%A4%A" });
    expect(parseRoute("/x")).toEqual({ kind: "unknown", path: "/x" });
  });
});
