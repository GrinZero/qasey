import { Streamdown, type StreamdownProps } from "streamdown";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Message({ className, from, ...props }: ComponentProps<"div"> & { from: "user" | "assistant" }) {
  return <div className={cn("chat-message", `chat-message--${from}`, className)} data-role={from} {...props} />;
}

export function MessageContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("message-content", className)} {...props} />;
}

export function MessageResponse({ className, ...props }: StreamdownProps) {
  return <Streamdown className={cn("assistant-text", className)} controls={{ code: { copy: true } }} dir="auto" {...props} />;
}
