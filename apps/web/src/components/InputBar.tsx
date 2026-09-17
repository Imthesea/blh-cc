import { useState } from "react";

export function InputBar(props: { busy: boolean; onSend(text: string): void }) {
  const { busy, onSend } = props;
  const [text, setText] = useState("");

  function submit() {
    const t = text.trim();
    if (t === "") return;
    setText("");
    onSend(t);
  }

  return (
    <form
      className="input-bar"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="输入消息…"
        disabled={busy}
      />
      <button type="submit" disabled={busy || text.trim() === ""}>
        发送
      </button>
    </form>
  );
}
