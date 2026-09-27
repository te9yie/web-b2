import { describe, expect, it } from "vitest";
import { TarError, type TarEntry, readTar } from "./tar";
import { type TarInput, makeTar, streamOf } from "./tar-test-helper";

const utf8 = (s: string) => new TextEncoder().encode(s);
const top = "owner-repo-abc1234";

async function collect(stream: ReadableStream<Uint8Array>, want: (path: string) => boolean = () => true): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  for await (const e of readTar(stream, want)) out.push(e);
  return out;
}

const texts = (entries: TarEntry[]) => entries.map((e) => [e.path, new TextDecoder().decode(e.bytes)]);

// 日本語で100バイトを超え、途中に / がないので prefix に分けられない名前
const longJa = `notes/${"長い名前".repeat(10)}.md`;
// 100バイトを超えるが prefix に分けられる名前
const longAscii = `notes/${"d".repeat(60)}/${"e".repeat(60)}.md`;

const sample: TarInput[] = [
  { path: "README.md", content: "# readme\n" },
  { path: "notes/a.md", content: "# A\n" },
  { path: "notes/link.md", type: "symlink", target: "a.md" },
  { path: longAscii, content: "# 長い ascii\n" },
  { path: longJa, content: "# 長い日本語\n" },
  { path: "notes/sub/b.md", content: "# B\n" },
];

describe("readTar", () => {
  it("通常のファイルを順に返し、ディレクトリ・シンボリックリンク・pax の global header は返さない", async () => {
    const got = await collect(streamOf(makeTar(sample, { top })));
    expect(texts(got)).toEqual([
      [`${top}/README.md`, "# readme\n"],
      [`${top}/notes/a.md`, "# A\n"],
      [`${top}/${longAscii}`, "# 長い ascii\n"],
      [`${top}/${longJa}`, "# 長い日本語\n"],
      [`${top}/notes/sub/b.md`, "# B\n"],
    ]);
  });

  it("prefix に分けた長いパスと pax の x で渡したパスを読み、x の path は次の1件にだけ効く", async () => {
    // 最後の区切りだけで100バイトを超えるので prefix に分けられない
    expect(utf8(longJa.slice(longJa.lastIndexOf("/") + 1)).length).toBeGreaterThan(100);
    const got = await collect(streamOf(makeTar([{ path: longJa, content: "1" }, { path: "notes/after.md", content: "2" }], { top })));
    expect(got.map((e) => e.path)).toEqual([`${top}/${longJa}`, `${top}/notes/after.md`]);
  });

  it("want が false のファイルは返さず、その後ろも正しく読める", async () => {
    const asked: string[] = [];
    const got = await collect(streamOf(makeTar(sample, { top })), (p) => {
      asked.push(p);
      return p.endsWith("/b.md") || p.endsWith("/README.md");
    });
    expect(texts(got)).toEqual([
      [`${top}/README.md`, "# readme\n"],
      [`${top}/notes/sub/b.md`, "# B\n"],
    ]);
    // want に聞くのは通常のファイルだけ
    expect(asked).toHaveLength(5);
  });

  it("塊の分け方に関係なく同じ結果になる", async () => {
    const tar = makeTar(sample, { top });
    const whole = texts(await collect(streamOf(tar)));
    expect(texts(await collect(streamOf(tar, 1)))).toEqual(whole);
    expect(texts(await collect(streamOf(tar, 513)))).toEqual(whole);
  });

  it("0バイト・512バイト・513バイトのファイルの詰め物の境目", async () => {
    const files = [
      { path: "empty.md", content: "" },
      { path: "512.md", content: "x".repeat(512) },
      { path: "513.md", content: "y".repeat(513) },
      { path: "last.md", content: "z" },
    ];
    const got = await collect(streamOf(makeTar(files, { top }), 100));
    expect(got.map((e) => [e.path, e.bytes.length])).toEqual([
      [`${top}/empty.md`, 0],
      [`${top}/512.md`, 512],
      [`${top}/513.md`, 513],
      [`${top}/last.md`, 1],
    ]);
    expect(new TextDecoder().decode(got[2].bytes)).toBe("y".repeat(513));
  });

  it("途中で切れていたら TarError。切れる前に返したファイルは受け取れている", async () => {
    const tar = makeTar(
      [
        { path: "a.md", content: "A" },
        { path: "b.md", content: "B".repeat(1000) },
      ],
      { top },
    );
    // 並び: global header(512+512)、top/(512)、a.md(512+512)、b.md(512+1024)、終わりの印(1024)
    const cuts: [number, string[]][] = [
      // b.md のヘッダーの途中
      [2560 + 100, ["a.md"]],
      // b.md の中身の途中
      [3072 + 500, ["a.md"]],
      // 終わりの印がない
      [4096, ["a.md", "b.md"]],
    ];
    for (const [cut, before] of cuts) {
      const got: TarEntry[] = [];
      const e = await (async () => {
        for await (const entry of readTar(streamOf(tar.slice(0, cut), 700), () => true)) got.push(entry);
      })().catch((err: unknown) => err);
      expect(e).toBeInstanceOf(TarError);
      expect(got.map((g) => g.path)).toEqual(before.map((p) => `${top}/${p}`));
    }
  });

  it("チェックサムが合わないヘッダーは TarError", async () => {
    const tar = makeTar([{ path: "a.md", content: "A" }], { top });
    // top/ のヘッダーの名前を1バイト変える
    tar[1024 + 5] ^= 1;
    await expect(collect(streamOf(tar))).rejects.toBeInstanceOf(TarError);
  });

  it("途中でループを抜けたらストリームを止める", async () => {
    let cancelled = false;
    const tar = makeTar(sample, { top });
    const source = streamOf(tar, 512);
    const reader = source.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const _ of readTar(stream, () => true)) break;
    expect(cancelled).toBe(true);
  });
});
