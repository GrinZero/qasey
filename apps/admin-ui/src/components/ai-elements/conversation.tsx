import { ArrowDown } from "lucide-react";
import type { ComponentProps } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { cn } from "@/lib/utils";

export function Conversation({ className, ...props }: ComponentProps<typeof StickToBottom>) {
  return <StickToBottom className={cn("qasey-conversation", className)} initial="smooth" resize="smooth" {...props} />;
}

export function ConversationContent({ className, ...props }: ComponentProps<typeof StickToBottom.Content>) {
  return <StickToBottom.Content className={cn("qasey-conversation-content", className)} scrollClassName="qasey-conversation-scroll" {...props} />;
}

export function ConversationScrollButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button className="conversation-scroll-button" type="button" aria-label="回到底部" onClick={() => void scrollToBottom()}>
      <ArrowDown size={16} />
    </button>
  );
}
