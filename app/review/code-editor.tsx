"use client";

import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { githubDark } from "@uiw/codemirror-theme-github";

// CodeMirror rather than Monaco. Monaco is ~2MB and brings an IDE — autocomplete,
// IntelliSense, a worker — to a box whose entire job is holding a snippet still
// while a model reads it. CodeMirror gives syntax highlighting and a line gutter
// for a fraction of the bundle, and the line gutter is the part that matters:
// findings are reported by line, so the user needs to see the numbers the model
// saw.

// An `aria-label` prop on the component lands on the wrapper div, where no screen
// reader will ever look — the element a reader actually focuses is the contenteditable
// `.cm-content` textbox inside. CodeMirror provides a facet for putting attributes on
// exactly that element, so the label goes through it.
const contentLabel = EditorView.contentAttributes.of({
  "aria-label": "Code to review",
});

export default function CodeEditor({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      editable={!disabled}
      theme={githubDark}
      extensions={[javascript({ jsx: true, typescript: true }), contentLabel]}
      height="420px"
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: false,
        autocompletion: false,
      }}
    />
  );
}
