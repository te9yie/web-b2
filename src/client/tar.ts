// tar を流しながら読む。GitHub の tarball（git archive の出力）が使う ustar と pax の拡張ヘッダーだけを扱う。
// pax の拡張ヘッダーは path だけを読む。8GiBを超えるファイル（git archive は pax の size で渡す）は扱わない。
// gzip の展開は呼ぶ側（DecompressionStream）で行う

export interface TarEntry {
  // tarball の中のパス（先頭のディレクトリを含む）
  path: string;
  bytes: Uint8Array;
}

export class TarError extends Error {}

const BLOCK = 512;
const decoder = new TextDecoder();

// 受け取った塊を並べておき、ちょうど n バイト読むか飛ばすだけの読み手。
// for await で ReadableStream を回す書き方は Safari にない（未確認）ので getReader() で読む
class ChunkReader {
  private chunks: Uint8Array[] = [];
  // chunks[0] の読み始めの位置
  private offset = 0;
  private available = 0;
  private ended = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async more(): Promise<void> {
    const { done, value } = await this.reader.read();
    if (done) {
      this.ended = true;
      return;
    }
    if (value.length > 0) {
      this.chunks.push(value);
      this.available += value.length;
    }
  }

  // ちょうど n バイト。足りずに終われば TarError
  async read(n: number): Promise<Uint8Array> {
    while (this.available < n) {
      if (this.ended) throw new TarError("tar が途中で切れている");
      await this.more();
    }
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0];
      const take = Math.min(n - filled, chunk.length - this.offset);
      out.set(chunk.subarray(this.offset, this.offset + take), filled);
      filled += take;
      this.consume(take);
    }
    return out;
  }

  // n バイト読み飛ばす。中身は写さない
  async skip(n: number): Promise<void> {
    let rest = n;
    while (rest > 0) {
      if (this.available === 0) {
        if (this.ended) throw new TarError("tar が途中で切れている");
        await this.more();
        continue;
      }
      const take = Math.min(rest, this.chunks[0].length - this.offset);
      this.consume(take);
      rest -= take;
    }
  }

  private consume(n: number): void {
    this.offset += n;
    this.available -= n;
    if (this.offset === this.chunks[0].length) {
      this.chunks.shift();
      this.offset = 0;
    }
  }
}

function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function octal(bytes: Uint8Array): number {
  const s = text(bytes).trim();
  if (!/^[0-7]*$/.test(s)) throw new TarError(`tar のヘッダーの数が読めない: ${s}`);
  return s === "" ? 0 : parseInt(s, 8);
}

// チェックサムの8バイトを空白とみなした総和
function checksumOf(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum;
}

// pax の拡張ヘッダーの中身（`長さ 鍵=値\n` の並び）
function paxRecords(bytes: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let pos = 0;
  while (pos < bytes.length) {
    const space = bytes.indexOf(0x20, pos);
    if (space < 0) break;
    const length = parseInt(decoder.decode(bytes.subarray(pos, space)), 10);
    if (!(length > 0) || pos + length > bytes.length) throw new TarError("pax の拡張ヘッダーが読めない");
    const record = decoder.decode(bytes.subarray(space + 1, pos + length - 1));
    const eq = record.indexOf("=");
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1));
    pos += length;
  }
  return records;
}

const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;

// 通常のファイルだけを順に返す。want が false のファイルは中身を写さずに読み飛ばす。
// 途中で切れていたら（ヘッダーや中身の途中で終わる、終わりの印がない）TarError を投げる。それまでに返したものはそのまま使ってよい。
// 呼ぶ側がループを途中で抜けたら、ストリームを止める
export async function* readTar(stream: ReadableStream<Uint8Array>, want: (path: string) => boolean): AsyncGenerator<TarEntry> {
  const reader = stream.getReader();
  const input = new ChunkReader(reader);
  try {
    // pax の x で渡された、次の1件の名前
    let paxPath: string | null = null;
    for (;;) {
      const header = await input.read(BLOCK);
      if (header.every((b) => b === 0)) return;
      if (octal(header.subarray(148, 156)) !== checksumOf(header)) throw new TarError("tar のヘッダーのチェックサムが合わない");
      if (header[124] & 0x80) throw new TarError("tar のファイルが大きすぎる");
      const size = octal(header.subarray(124, 136));
      const type = String.fromCharCode(header[156]);
      let name = text(header.subarray(0, 100));
      if (text(header.subarray(257, 263)).startsWith("ustar")) {
        const prefix = text(header.subarray(345, 500));
        if (prefix !== "") name = `${prefix}/${name}`;
      }
      if (type === "x") {
        const records = paxRecords(await input.read(size));
        await input.skip(padded(size) - size);
        paxPath = records.get("path") ?? null;
        continue;
      }
      const path = paxPath ?? name;
      paxPath = null;
      if ((type === "0" || type === "\0") && want(path)) {
        const bytes = await input.read(size);
        await input.skip(padded(size) - size);
        yield { path, bytes };
        continue;
      }
      // 読まないファイル、ディレクトリ、シンボリックリンク、pax の global header（g）など
      await input.skip(padded(size));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
