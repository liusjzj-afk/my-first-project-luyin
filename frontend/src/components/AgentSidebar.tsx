import { useEffect, useRef } from "react";
import { Bot, Loader2, Send, Sparkles, UserRound } from "lucide-react";
import type { ChatMessage } from "../types/meeting";

type AgentSidebarProps = {
  canChat: boolean;
  chatMessages: ChatMessage[];
  chatInput: string;
  isAiThinking: boolean;
  onChangeChatInput: (value: string) => void;
  onSendMessage: () => void;
};

export function AgentSidebar({
  canChat,
  chatMessages,
  chatInput,
  isAiThinking,
  onChangeChatInput,
  onSendMessage
}: AgentSidebarProps) {
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages, isAiThinking]);

  return (
    <aside className="agent-glass">
      <div className="agent-title">
        <div className="agent-pulse">
          <Bot size={18} />
        </div>
        <div>
          <strong>AI Agent</strong>
          <span>基于会议纪要与逐字稿回答</span>
        </div>
      </div>

      <div className="agent-thread custom-scrollbar">
        {chatMessages.length || isAiThinking ? (
          <>
            {chatMessages.map((message, index) => <ChatBubble key={`${message.role}-${index}`} message={message} />)}
            {isAiThinking && <AiThinkingBubble />}
            <div ref={threadEndRef} />
          </>
        ) : (
          <div className="agent-empty-state">
            <Sparkles size={28} />
            <strong>Ask with context</strong>
            <p>可以询问需求优先级、未确认事项、会议行动项或某个模块的业务规则。</p>
          </div>
        )}
      </div>

      <div className="agent-composer">
        {!canChat && <p>会议完成后可提问</p>}
        <div className="composer-box">
          <textarea
            value={chatInput}
            rows={3}
            disabled={!canChat || isAiThinking}
            onChange={(event) => onChangeChatInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSendMessage();
              }
            }}
            placeholder="询问这场会议的需求、风险或下一步..."
          />
          <button disabled={!chatInput.trim() || !canChat || isAiThinking} onClick={onSendMessage} aria-label="发送">
            {isAiThinking ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
          </button>
        </div>
      </div>
    </aside>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`chat-row ${isUser ? "user" : "assistant"}`}>
      <div className="chat-avatar">{isUser ? <UserRound size={15} /> : <Bot size={15} />}</div>
      <div className="chat-message">{message.content}</div>
    </div>
  );
}

function AiThinkingBubble() {
  return (
    <div className="chat-row assistant">
      <div className="chat-avatar">
        <Loader2 className="animate-spin" size={15} />
      </div>
      <div className="chat-message thinking">AI 正在结合会议纪要检索中...</div>
    </div>
  );
}
