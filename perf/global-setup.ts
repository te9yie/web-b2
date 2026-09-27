// 合成データを perf/.data/notes に書き出す。件数が合っていれば書き直さない
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { synthesize } from "./synth";

export const DATA_DIR = "perf/.data";
export const COUNT = 10000;

const OPTIONS = { count: COUNT, bytesPerPage: 5600, seed: 1 };

export default async function globalSetup(): Promise<void> {
  // 生成したときの条件を params.json に残し、条件か件数が違えば作り直す
  const params = join(DATA_DIR, "params.json");
  const notes = join(DATA_DIR, "notes");
  const existing = await readdir(notes, { recursive: true }).catch(() => [] as string[]);
  const saved = await readFile(params, "utf8").catch(() => "");
  if (existing.filter((f) => f.endsWith(".md")).length === COUNT && saved === JSON.stringify(OPTIONS)) return;
  await rm(DATA_DIR, { recursive: true, force: true });
  const files = synthesize(OPTIONS);
  const dirs = new Set(files.map((f) => dirname(join(DATA_DIR, f.path))));
  for (const d of dirs) await mkdir(d, { recursive: true });
  // 一度に開くファイルの数を抑える（全件を同時に書くと EMFILE になる）
  for (let i = 0; i < files.length; i += 100) {
    await Promise.all(files.slice(i, i + 100).map((f) => writeFile(join(DATA_DIR, f.path), f.content, "utf8")));
  }
  await writeFile(params, JSON.stringify(OPTIONS), "utf8");
}
