// CodeMirror 6 のエディタ。大きいので、初めて編集するときに動的 import する（DECISIONS.md 2026-09-27「CodeMirror 6 を入れる」）。
// ノートを書く用なので、basicSetup の行番号・折りたたみ・検索パネルは入れず、履歴・選択の描画・括弧の補完・Markdown の
// 構文色と箇条書きの継続（Enter）だけにする。`[[` を打つと `]]` が補われる

export interface Editor {
  value(): string;
  focus(): void;
  destroy(): void;
}

export async function createEditor(parent: HTMLElement, content: string, onChange: (value: string) => void): Promise<Editor> {
  const [{ EditorView, minimalSetup }, { markdown, markdownKeymap }, { closeBrackets, closeBracketsKeymap }, { keymap }] =
    await Promise.all([
      import("codemirror"),
      import("@codemirror/lang-markdown"),
      import("@codemirror/autocomplete"),
      import("@codemirror/view"),
    ]);
  const view = new EditorView({
    parent,
    doc: content,
    extensions: [
      minimalSetup,
      markdown(),
      closeBrackets(),
      keymap.of([...closeBracketsKeymap, ...markdownKeymap]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange(update.state.doc.toString());
      }),
    ],
  });
  return {
    value: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
