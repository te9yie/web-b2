// CodeMirror 6 のエディタ。大きいので、初めて編集するときに動的 import する（DECISIONS.md 2026-09-27「CodeMirror 6 を入れる」）

export interface Editor {
  value(): string;
  focus(): void;
  destroy(): void;
}

export async function createEditor(parent: HTMLElement, content: string, onChange: (value: string) => void): Promise<Editor> {
  const [{ EditorView, basicSetup }, { markdown }, { EditorState }] = await Promise.all([
    import("codemirror"),
    import("@codemirror/lang-markdown"),
    import("@codemirror/state"),
  ]);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    value: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
