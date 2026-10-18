// A bare message box for a conversation (Home's Main agent, an idea's chat):
// what you type is sent, then the caller shows the conversation.
import { useState } from 'react';
import { api } from '../lib/api';

export function QuickAsk({ conversationId, placeholder, onSent, above }: { conversationId: string; placeholder: string; onSent: () => void; above?: React.ReactNode }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setError(null);
    try {
      await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { body: { text: t } });
      setText('');
      onSent();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="quick-ask">
      {above}
      <form className="composer" onSubmit={(e) => (e.preventDefault(), send())}>
        <label htmlFor={`ask-${conversationId}`} className="sr-only">Message</label>
        <textarea
          id={`ask-${conversationId}`}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), send());
          }}
          placeholder={placeholder}
        />
        {error && <div className="error">{error}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="muted" style={{ fontSize: 11 }}>Enter to send · Shift+Enter for a new line</span>
          <button type="submit" className="btn sm primary" style={{ marginLeft: 'auto' }} disabled={!text.trim()}>Send</button>
        </div>
      </form>
    </div>
  );
}
