import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDraft, dirtyDrafts, getDraft, openDraft, updateDraft } from "./drafts";
import { Kb } from "./kb";
import { Saver, withUpdated } from "./saver";
import type { Source } from "./source";
import { MemoryStore, type StoredFile } from "./store";

describe("withUpdated", () => {
  it("updated を差し替える。なければ足す。同じ日なら変えない", () => {
    expect(withUpdated("---\ncreated: 2026-01-01\nupdated: 2026-01-02\n---\n# a\n", "2026-02-03")).toBe(
      "---\ncreated: 2026-01-01\nupdated: 2026-02-03\n---\n# a\n",
    );
    expect(withUpdated("---\ncreated: 2026-01-01\n---\n# a\n", "2026-02-03")).toBe("---\ncreated: 2026-01-01\nupdated: 2026-02-03\n---\n# a\n");
    const same = "---\nupdated: 2026-02-03\n---\n";
    expect(withUpdated(same, "2026-02-03")).toBe(same);
    expect(withUpdated('---\nupdated: "2026-02-03"\n---\n', "2026-02-03")).toBe('---\nupdated: "2026-02-03"\n---\n');
  });

  it("front matter のないページには何もしない", () => {
    expect(withUpdated("# a\n\n---\nx\n---\n", "2026-02-03")).toBe("# a\n\n---\nx\n---\n");
  });

  it("空の front matter と CRLF でも形を壊さない", () => {
    expect(withUpdated("---\n---\n# a\n", "2026-02-03")).toBe("---\nupdated: 2026-02-03\n---\n# a\n");
    expect(withUpdated("---\r\ncreated: 2026-01-01\r\nupdated: 2026-01-02\r\n---\r\n# a\r\n", "2026-02-03")).toBe(
      "---\r\ncreated: 2026-01-01\r\nupdated: 2026-02-03\r\n---\r\n# a\r\n",
    );
    expect(withUpdated("---\r\ncreated: 2026-01-01\r\n---\r\n# a\r\n", "2026-02-03")).toBe(
      "---\r\ncreated: 2026-01-01\r\nupdated: 2026-02-03\r\n---\r\n# a\r\n",
    );
  });
});

// 書き込みを記録する取り込み元
class FakeSource implements Source {
  readonly writes: { path: string; content: string; sha: string | null; message: string; keepalive?: boolean }[] = [];
  fail: string | null = null;
  constructor(readonly files: Map<string, StoredFile>) {}
  async dir() {
    return "notes";
  }
  async list() {
    return [...this.files.values()].map(({ path, sha }) => ({ path, sha }));
  }
  async read(path: string) {
    return { ...this.files.get(path)! };
  }
  async write(path: string, content: string, sha: string | null, message: string, options: { keepalive?: boolean } = {}) {
    if (this.fail) throw new Error(this.fail);
    this.writes.push({ path, content, sha, message, keepalive: options.keepalive });
    const next = `sha${this.writes.length}`;
    this.files.set(path, { path, sha: next, content });
    return { sha: next };
  }
}

const PATH = "notes/a.md";
const ORIGINAL = "---\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# A\n\n本文\n";

async function setup(delay = 1000) {
  const source = new FakeSource(new Map([[PATH, { path: PATH, sha: "sha0", content: ORIGINAL }]]));
  const kb = await Kb.open(new MemoryStore());
  await kb.sync(source);
  const results: { path: string; ok: boolean }[] = [];
  const saver = new Saver(kb, source, () => "2026-09-27", delay, (r) => results.push(r));
  const draft = openDraft((await kb.content(PATH))!);
  return { source, kb, saver, draft, results };
}

describe("Saver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    clearDraft(PATH);
  });

  it("入力が止まって delay 経つと1回だけ保存し、updated をその日にし、控えと索引に反映する", async () => {
    const { source, kb, saver, results } = await setup();
    updateDraft(PATH, ORIGINAL.replace("# A", "# A2"));
    await vi.advanceTimersByTimeAsync(600);
    updateDraft(PATH, ORIGINAL.replace("# A", "# A3"));
    await vi.advanceTimersByTimeAsync(600);
    expect(source.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(source.writes.length).toBe(1);
    expect(source.writes[0]).toMatchObject({ path: PATH, sha: "sha0", message: "web: A3" });
    expect(source.writes[0].content).toBe("---\ncreated: 2026-01-01\nupdated: 2026-09-27\n---\n# A3\n\n本文\n");
    expect(kb.index.get("a")?.title).toBe("A3");
    expect(kb.index.get("a")?.sha).toBe("sha1");
    expect((await kb.content(PATH))?.content).toContain("updated: 2026-09-27");
    expect(results).toEqual([{ path: PATH, ok: true }]);
    // 基準が新しくなり、変わっていない扱いになる
    expect(dirtyDrafts()).toEqual([]);
    expect(getDraft(PATH)?.base.sha).toBe("sha1");
    void saver;
  });

  it("flush はすぐ保存し、keepalive を渡す。変わっていなければ何もしない", async () => {
    const { source, saver } = await setup();
    expect(await saver.flush()).toEqual([]);
    updateDraft(PATH, `${ORIGINAL}追記\n`);
    await saver.flush({ keepalive: true });
    expect(source.writes.length).toBe(1);
    expect(source.writes[0].keepalive).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(source.writes.length).toBe(1);
  });

  it("送っている途中の編集は次の保存に回り、新しい sha で送る", async () => {
    const { source, saver } = await setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const write = source.write.bind(source);
    source.write = async (...args) => {
      await gate;
      return write(...args);
    };
    updateDraft(PATH, `${ORIGINAL}1\n`);
    const first = saver.flush();
    // 最初の保存が中身を読んで送り始めるまで待ってから、続きを編集する
    await vi.advanceTimersByTimeAsync(0);
    updateDraft(PATH, `${ORIGINAL}1\n2\n`);
    const second = saver.flush();
    const third = saver.flush();
    release();
    await Promise.all([first, second, third]);
    // 進行中に重なった flush は一つずつ連なり、同じ内容を二重には送らない
    expect(source.writes.map((w) => [w.sha, w.content.endsWith("1\n2\n")])).toEqual([
      ["sha0", false],
      ["sha1", true],
    ]);
    expect(dirtyDrafts()).toEqual([]);
  });

  it("書けたあとに控えへの反映が失敗しても、基準は新しい sha になる", async () => {
    const { source, saver, kb } = await setup();
    const put = kb.put.bind(kb);
    kb.put = async () => {
      throw new Error("控えに書けない");
    };
    updateDraft(PATH, `${ORIGINAL}x\n`);
    const [result] = await saver.flush();
    expect(result.ok).toBe(true);
    expect(getDraft(PATH)?.base.sha).toBe("sha1");
    expect(source.writes.length).toBe(1);
    kb.put = put;
  });

  it("失敗したら下書きを残し、次の機会に同じ sha で送り直す", async () => {
    const { source, saver, results } = await setup();
    source.fail = "落ちた";
    updateDraft(PATH, `${ORIGINAL}x\n`);
    await saver.flush();
    expect(results).toEqual([{ path: PATH, ok: false, error: "落ちた" }]);
    expect(saver.lastError).toBe("落ちた");
    expect(dirtyDrafts().length).toBe(1);
    source.fail = null;
    await saver.flush();
    expect(source.writes.length).toBe(1);
    expect(source.writes[0].sha).toBe("sha0");
    expect(saver.lastError).toBeNull();
    expect(dirtyDrafts()).toEqual([]);
  });
});
