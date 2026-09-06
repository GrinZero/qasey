import { useRef, useState } from "react";
import { ArrowRight, AtSign, X } from "lucide-react";
import type { ConversationParticipant } from "@qasey/contracts";

export function CollaborationComposer({ value, onChange, participants, recipients, onRecipients, onSubmit, disabled = false }: {
  value: string; onChange: (value: string) => void; participants: ConversationParticipant[];
  recipients: string[]; onRecipients: (ids: string[]) => void; onSubmit: () => Promise<void>; disabled?: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ start: number; end: number; text: string } | null>(null);
  const [selected, setSelected] = useState(0);
  const selectedIds = new Set(recipients);
  const options = participants.filter(p => !selectedIds.has(p.agentId) && (!query?.text || `${p.name} ${p.agentId}`.toLowerCase().includes(query.text.toLowerCase())));
  const choose = (agentId: string) => {
    onRecipients([...recipients, agentId]);
    if (query) onChange(value.slice(0, query.start) + value.slice(query.end));
    setQuery(null); setSelected(0); input.current?.focus();
  };
  return <form className="conversation-composer collaboration-composer" onSubmit={event => { event.preventDefault(); if (!disabled && value.trim()) void onSubmit(); }}>
    <div className="conversation-recipients" aria-label="消息接收者">
      <AtSign size={15} />{recipients.length ? recipients.map(id => <button key={id} type="button" onClick={() => onRecipients(recipients.filter(value => value !== id))} aria-label={`移除接收者 ${participants.find(p => p.agentId === id)?.name ?? id}`}>@{participants.find(p => p.agentId === id)?.name ?? id}<X size={12} /></button>) : <span>发送给 Qasey · 输入 @ 指定参与者</span>}
    </div>
    <label className="sr-only" htmlFor="qa-prompt">发送给 Qasey 或 @ Agent</label>
    <textarea ref={input} id="qa-prompt" value={value} rows={3} disabled={disabled}
      placeholder="输入需求、补充要求，或 @ Agent…"
      aria-controls={query ? "agent-mentions" : undefined} aria-autocomplete="list"
      aria-activedescendant={query && options[selected] ? `mention-${options[selected]!.agentId}` : undefined}
      onChange={event => {
        const text = event.target.value; onChange(text);
        const end = event.target.selectionStart;
        const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, end));
        setQuery(match ? { start: end - match[1]!.length - 1, end, text: match[1]! } : null); setSelected(0);
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (query && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
          event.preventDefault();
          if (event.key === "Escape") setQuery(null);
          else if (event.key === "Enter" && options[selected]) choose(options[selected]!.agentId);
          else setSelected(index => options.length ? (index + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length : 0);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!disabled && value.trim()) void onSubmit(); }
      }} />
    {query && <div id="agent-mentions" role="listbox" aria-label="会话 Agent" className="agent-mentions">
      {options.map((p, index) => <button id={`mention-${p.agentId}`} key={p.agentId} type="button" role="option" aria-selected={index === selected} onMouseDown={event => event.preventDefault()} onClick={() => choose(p.agentId)}><strong>{p.name}</strong><small>{p.description}</small></button>)}
      {!options.length && <p>没有匹配的会话参与者</p>}
    </div>}
    <div><span>Shift + Enter 换行 · 执行期间可继续发送</span><button type="submit" className="primary-button" disabled={disabled || !value.trim()}><ArrowRight size={17} />发送</button></div>
  </form>;
}
