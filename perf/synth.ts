// 計測用の合成データ。SPEC.md「性能」の条件（1万ページ・合計64MB程度）に合わせて、
// 見本ノートと同じ形（front matter、H1、[[リンク]]、#タグ、コードブロック）のページを決まった乱数で作る。
// 個人情報や実在の名前は入れない。語は文字の並びから作る

export interface SynthFile {
  path: string;
  content: string;
}

export interface SynthOptions {
  // ページ数
  count?: number;
  // 1ページあたりのおおよそのバイト数。合計がこれ×count に近くなるように本文の長さを決める
  bytesPerPage?: number;
  seed?: number;
}

// mulberry32。同じ seed なら同じ列
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 常用漢字の一部とひらがなから語を作る
const KANJI = "日月火水木金土山川田人口手目耳足心力体気時分年前後上下左右中外内大小高低長短新古明暗多少強弱早遅近遠広狭深浅重軽軟硬白黒赤青緑黄春夏秋冬東西南北朝昼夜雨雪風雲空海島森林花草鳥魚犬猫馬牛羊虫石米茶酒肉飯油塩豆麦道路橋駅町村市国家店寺校園院館室門窓床壁柱屋庭池井山谷野原岩砂泥音声色形数字文書本紙筆絵歌詩話言語問答学知思考感情夢愛信望楽苦悲喜怒安危全半各毎同他自友親兄弟姉妹子母父祖孫夫妻男女児老若生死病薬医食飲住衣着服帽靴傘鏡机椅箱袋箸皿椀壺鍋釜火炎煙灰炭鉄銅銀玉宝石";
const HIRA = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";

function makeWords(rand: () => number, n: number): string[] {
  const words = new Set<string>();
  while (words.size < n) {
    const len = 2 + Math.floor(rand() * 3);
    let w = "";
    for (let i = 0; i < len; i++) {
      const pool = rand() < 0.7 ? KANJI : HIRA;
      w += pool[Math.floor(rand() * pool.length)];
    }
    words.add(w);
  }
  return [...words];
}

function pick<T>(rand: () => number, xs: T[]): T {
  return xs[Math.floor(rand() * xs.length)];
}

function dateOf(day: number): string {
  const d = new Date(Date.UTC(2000, 0, 1) + day * 86400000);
  return d.toISOString().slice(0, 10);
}

export function synthesize({ count = 10000, bytesPerPage = 6400, seed = 1 }: SynthOptions = {}): SynthFile[] {
  const rand = rng(seed);
  const words = makeWords(rand, 3000);
  const tags = makeWords(rand, 300);
  const people = makeWords(rand, 500).map((w) => `${w} ${pick(rand, words)}`);

  // 先に name と title を決めておき、リンクはそこから選ぶ
  const names: string[] = [];
  const titles: (string | null)[] = [];
  for (let i = 0; i < count; i++) {
    const date = dateOf(Math.floor(i * 0.9));
    const slug = i % 10 === 0 ? "" : `-${pick(rand, words)}-${i}`;
    names.push(`${date}${slug}`);
    const r = rand();
    if (r < 0.05) titles.push(null);
    else if (r < 0.1 && i > 0) titles.push(titles[Math.floor(rand() * i)] ?? `${pick(rand, words)}${pick(rand, words)}`);
    else titles.push(`${pick(rand, words)}${pick(rand, words)}${i % 7 === 0 ? `の${pick(rand, words)}` : ""}`);
  }

  const sentence = (n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) s += pick(rand, words) + (rand() < 0.3 ? "、" : "");
    return `${s}。`;
  };
  const link = () => {
    const r = rand();
    if (r < 0.7) return `[[${pick(rand, names)}]]`;
    if (r < 0.9) {
      const t = titles[Math.floor(rand() * count)];
      return t ? (rand() < 0.3 ? `[[${t}|${pick(rand, words)}]]` : `[[${t}]]`) : `[[${pick(rand, names)}]]`;
    }
    return `[[${pick(rand, people)}]]`;
  };

  const files: SynthFile[] = [];
  for (let i = 0; i < count; i++) {
    const name = names[i];
    const created = name.slice(0, 10);
    const updated = dateOf(Math.min(Math.floor(i * 0.9) + Math.floor(rand() * 400), 9999));
    const fmTags = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(rand, tags));
    const parts: string[] = [`---\ncreated: ${created}\nupdated: ${updated}\ntags: [${[...new Set(fmTags)].join(", ")}]\n---\n`];
    if (titles[i] !== null) parts.push(`\n# ${titles[i]}\n`);

    // 長さは対数正規に近い散らし方にして、短いページが多く、まれに長いページがある形にする
    const scale = Math.exp((rand() + rand() + rand() - 1.5) * 1.2);
    const target = Math.max(300, Math.floor(bytesPerPage * scale));
    let bytes = 0;
    let section = 0;
    while (bytes < target) {
      const r = rand();
      let block: string;
      if (r < 0.15) {
        block = `\n## ${pick(rand, words)}${pick(rand, words)}\n`;
        section++;
      } else if (r < 0.3) {
        // 箇条書き。3項目に1つくらいリンクを入れる
        const items = Array.from({ length: 2 + Math.floor(rand() * 4) }, () => `- ${sentence(3)}${rand() < 0.35 ? ` ${link()}` : ""}`);
        block = `\n${items.join("\n")}\n`;
      } else if (r < 0.36) {
        block = `\n\`\`\`js\nconst x = "[[${pick(rand, names)}]]"; // #${pick(rand, tags)}\n\`\`\`\n`;
      } else {
        // 段落。4つに1つくらいリンク、10に1つくらいタグを入れる
        const tag = rand() < 0.1 ? ` #${pick(rand, tags)}` : "";
        const l = rand() < 0.25 ? link() : "";
        block = `\n${sentence(6)}${l}${sentence(5)}\`${pick(rand, words)}\`${sentence(4)}${tag}\n`;
      }
      parts.push(block);
      // UTF-8 の漢字はほぼ3バイト
      bytes += block.length * 2.6;
    }
    const dir = i % 50 === 0 ? "notes/sub" : "notes";
    files.push({ path: `${dir}/${name}.md`, content: parts.join("") });
    void section;
  }
  return files;
}

export function totalBytes(files: SynthFile[]): number {
  const enc = new TextEncoder();
  let n = 0;
  for (const f of files) n += enc.encode(f.content).length;
  return n;
}
