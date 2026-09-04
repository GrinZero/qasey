import { ArrowRight, LoaderCircle } from "lucide-react";
import { useRef, type FormEvent, type KeyboardEvent } from "react";

export interface PromptInputProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
}

export function PromptInput({ value, onValueChange, onSubmit, disabled = false, placeholder }: PromptInputProps) {
  const composing = useRef(false);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!disabled && value.trim()) void onSubmit();
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || composing.current || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  return (
    <form className="conversation-composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="qa-prompt">发送给 Qasey</label>
      <textarea
        id="qa-prompt"
        value={value}
        onChange={event => onValueChange(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={keyDown}
        placeholder={placeholder ?? "输入需求、补充信息或追问…"}
        rows={3}
        disabled={disabled}
      />
      <div>
        <span>{value.length ? `${value.length} 字 · Shift + Enter 换行` : "草稿自动保存在此设备"}</span>
        <button className="primary-button" type="submit" disabled={disabled || !value.trim()}>
          {disabled ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
          {disabled ? "Qasey 处理中" : "发送"}
        </button>
      </div>
    </form>
  );
}
