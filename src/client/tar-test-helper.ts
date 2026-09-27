// テスト用に、git archive と同じ並びの tar と tar.gz を作る。
// 先頭に pax の global header（comment にコミット）、top/ のディレクトリ、各ファイルの前にその親のディレクトリ、最後に0の1024バイト。
// 本物の git archive の出力と同じ形になっているかは、これでは確かめられない（未確認）
import { gzipSync } from "node:zlib";

export interface TarInput {
  // top/ の下のパス
  path: string;
  content?: string | Uint8Array;
  // symlink のときはリンク先
  target?: string;
  type?: "file" | "symlink";
}

const encoder = new TextEncoder();
const BLOCK = 512;
// git archive は 10240 バイトの倍数まで詰める
const RECORD = 10240;

function putString(header: Uint8Array, offset: number, length: number, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  header.set(bytes.subarray(0, length), offset);
}

function putOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  putString(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function header(name: Uint8Array, prefix: Uint8Array, size: number, type: string, linkname = ""): Uint8Array {
  const h = new Uint8Array(BLOCK);
  putString(h, 0, 100, name);
  putOctal(h, 100, 8, type === "5" ? 0o775 : 0o664);
  putOctal(h, 108, 8, 0);
  putOctal(h, 116, 8, 0);
  putOctal(h, 124, 12, size);
  putOctal(h, 136, 12, 1767225600);
  h[156] = type.charCodeAt(0);
  putString(h, 157, 100, linkname);
  putString(h, 257, 6, "ustar\0");
  putString(h, 263, 2, "00");
  putString(h, 265, 32, "root");
  putString(h, 297, 32, "root");
  putString(h, 345, 155, prefix);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  putString(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

// `長さ 鍵=値\n`。長さは自分の桁を含むバイト数
function paxRecord(key: string, value: string): Uint8Array {
  const body = encoder.encode(` ${key}=${value}\n`);
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return encoder.encode(`${length} ${key}=${value}\n`);
}

function withPadding(bytes: Uint8Array): Uint8Array[] {
  const rest = bytes.length % BLOCK;
  return rest === 0 ? [bytes] : [bytes, new Uint8Array(BLOCK - rest)];
}

// 名前を ustar の name と prefix に分ける。分けられなければ pax の x で渡す
function entry(path: string, data: Uint8Array, type: string, linkname = ""): Uint8Array[] {
  const full = encoder.encode(path);
  if (full.length <= 100) return [header(full, new Uint8Array(0), data.length, type, linkname), ...withPadding(data)];
  for (let i = full.length - 1; i > 0; i--) {
    if (full[i] !== 0x2f) continue;
    const prefix = full.subarray(0, i);
    const name = full.subarray(i + 1);
    if (prefix.length <= 155 && name.length <= 100 && name.length > 0) {
      return [header(name, prefix, data.length, type, linkname), ...withPadding(data)];
    }
  }
  const pax = paxRecord("path", path);
  // name には切り詰めたものを入れる（読む側は pax の path を使う）
  return [header(encoder.encode("PaxHeaders/long"), new Uint8Array(0), pax.length, "x"), ...withPadding(pax), header(full.subarray(0, 100), new Uint8Array(0), data.length, type, linkname), ...withPadding(data)];
}

export function makeTar(entries: TarInput[], { top = "owner-repo-0000000", comment = "0".repeat(40) } = {}): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const global = paxRecord("comment", comment);
  parts.push(header(encoder.encode("pax_global_header"), new Uint8Array(0), global.length, "g"), ...withPadding(global));
  const dirs = new Set<string>();
  const dir = (path: string) => {
    if (dirs.has(path)) return;
    dirs.add(path);
    parts.push(...entry(`${path}/`, new Uint8Array(0), "5"));
  };
  dir(top);
  for (const e of entries) {
    const segments = e.path.split("/");
    for (let i = 1; i < segments.length; i++) dir(`${top}/${segments.slice(0, i).join("/")}`);
    const path = `${top}/${e.path}`;
    if (e.type === "symlink") parts.push(...entry(path, new Uint8Array(0), "2", e.target ?? ""));
    else parts.push(...entry(path, typeof e.content === "string" ? encoder.encode(e.content) : (e.content ?? new Uint8Array(0)), "0"));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  let length = parts.reduce((n, p) => n + p.length, 0);
  if (length % RECORD !== 0) {
    parts.push(new Uint8Array(RECORD - (length % RECORD)));
    length = parts.reduce((n, p) => n + p.length, 0);
  }
  const out = new Uint8Array(length);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function makeTarGz(entries: TarInput[], options: { top?: string; comment?: string } = {}): Uint8Array<ArrayBuffer> {
  return new Uint8Array(gzipSync(makeTar(entries, options)));
}

// バイト列を size バイトずつの塊で流す
export function streamOf(bytes: Uint8Array, size = 65536): ReadableStream<Uint8Array<ArrayBuffer>> {
  let pos = 0;
  return new ReadableStream({
    pull(controller) {
      if (pos >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(pos, pos + size));
      pos += size;
    },
  });
}

// 本物の git archive の出力（git 2.53.0.windows.1、src/client/testdata/git-archive.tar.gz、727バイト）。
// 空のリポジトリに hash-object と update-index で下のファイルを置き（.gitattributes は `notes/crlf.md text eol=crlf`、
// notes/link.md は a.md へのシンボリックリンク）、commit-tree したものを
// `git archive --format=tar.gz --prefix=owner-repo-abc1234/ <commit>` で出した。blobs は `git ls-tree -r` の sha
export const gitArchiveSample = {
  file: "src/client/testdata/git-archive.tar.gz",
  top: "owner-repo-abc1234",
  blobs: {
    ".gitattributes": { sha: "d2c2770c1b1321bbd0919c6f329f63859fbf99aa", content: "notes/crlf.md text eol=crlf\n" },
    "notes/513.md": { sha: "0aa733449e1354ca352fbd8b599715330e6b9a8a", content: "y".repeat(513) },
    "notes/a.md": { sha: "7f3b95d297183eca8f6cf38ceaa253bee8c2d7cd", content: "# A\n" },
    // eol=crlf で、tarball の中では CRLF になっている（18バイトが21バイト）
    "notes/crlf.md": { sha: "2e61f6383136440542003bf78b66d9040f9da8b4", content: "# CRLF\n\n二行目\n" },
    // ustar の prefix に分けられるパス
    [`notes/${"d".repeat(60)}/${"e".repeat(60)}.md`]: { sha: "c6ac7593c4e212c7f73ac30a63766050aa079337", content: "# prefix に分けるパス\n" },
    "notes/empty.md": { sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", content: "" },
    // tarball ではシンボリックリンク（種類 2）なので中身は返らない
    "notes/link.md": { sha: "e77de8562fa61286381cc40e34a75024c20e17eb", content: "a.md" },
    // 先頭のディレクトリを含めて名前の欄がちょうど100バイト（NUL で終わらない）
    [`notes/${"x".repeat(72)}.md`]: { sha: "97aef7288d2a3396ccb9c103ed122c4ef81491c0", content: "# 名前の欄がちょうど100バイト\n" },
    // 最後の区切りが100バイトを超えるので pax の x で渡される
    [`notes/${"長い名前".repeat(10)}.md`]: { sha: "50f7e5c37dc8b1d5eb92de54ef76f9cdb4a94bf2", content: "# pax で渡すパス\n" },
  } as Record<string, { sha: string; content: string }>,
};
