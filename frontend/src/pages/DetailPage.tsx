import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, FileText, MessageSquareText, Network } from "lucide-react";
import { resolveApiUrl, sendMeetingChat, API_BASE_URL, retryMeetingSummary } from "../api/meetings";
import { AgentSidebar } from "../components/AgentSidebar";
import { MarkdownDocument } from "../components/MarkdownDocument";
import { StatusBadge } from "../components/StatusBadge";
import { TabButton } from "../components/TabButton";
import { TranscriptPlayerDocument } from "../components/TranscriptPlayerDocument";
import { useMeetingStatus } from "../hooks/useMeetingStatus";
import type { ChatMessage, DetailTab } from "../types/meeting";
import { formatDateTime, formatDuration } from "../utils/time";

export function DetailPage() {
  const navigate = useNavigate();
  const { meetingId = "" } = useParams();
  const { meeting, error: statusError } = useMeetingStatus(meetingId);
  const [activeTab, setActiveTab] = useState<DetailTab>("summary");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isAiThinking, setIsAiThinking] = useState(false);

  const transcript = meeting?.transcript || [];
  const canChat = meeting?.status === "COMPLETED" && transcript.length > 0;
  const summary = meeting?.summary_content || meeting?.summary_markdown || "";
  const ia = meeting?.ia_content || "## 暂无信息架构\n\n当前会议尚未生成信息架构与优先级内容。";
  const audioUrl = meeting?.audio_url ? resolveApiUrl(meeting.audio_url) : meetingId ? `${API_BASE_URL}/api/meetings/${meetingId}/audio` : "";
  const canRetrySummary = meeting?.asr_status === "COMPLETED" && meeting?.llm_status === "FAILED";

  const sendMessage = async () => {
    const message = chatInput.trim();
    if (!message || !meetingId || !canChat || isAiThinking) return;
    setChatInput("");
    setIsAiThinking(true);
    setChatMessages((items) => [...items, { role: "user", content: message }]);
    try {
      const reply = await sendMeetingChat(meetingId, message);
      setChatMessages((items) => [...items, { role: "assistant", content: reply }]);
    } catch (error) {
      setChatMessages((items) => [...items, { role: "assistant", content: error instanceof Error ? error.message : "发送失败" }]);
    } finally {
      setIsAiThinking(false);
    }
  };

  const retrySummary = async () => {
    if (!meetingId) return;
    try {
      await retryMeetingSummary(meetingId);
      setChatMessages((items) => [...items, { role: "assistant", content: "已重新触发需求纪要生成。" }]);
    } catch (retryError) {
      setChatMessages((items) => [...items, { role: "assistant", content: retryError instanceof Error ? retryError.message : "重试失败" }]);
    }
  };

  return (
    <main className="detail-tech-shell h-screen w-screen overflow-hidden">
      <header className="detail-tech-topbar">
        <button className="back-control" onClick={() => navigate("/")}>
          <ArrowLeft size={18} />
          返回列表
        </button>
        <div className="detail-heading">
          <strong>{meeting?.title || "会议加载中"}</strong>
          <span>{statusError || (meeting?.upload_time ? formatDateTime(meeting.upload_time) : "读取会议数据")} · {formatDuration(meeting?.audio_duration || meeting?.duration_seconds || 0)}</span>
        </div>
        <StatusBadge status={meeting?.status || "PROCESSING"} />
      </header>

      <section className="detail-tech-layout">
        <section className="document-stage">
          <div className="document-tabs" role="tablist" aria-label="会议文档导航">
            <TabButton active={activeTab === "summary"} icon={<FileText size={17} />} label="系统需求分析纪要" onClick={() => setActiveTab("summary")} />
            <TabButton active={activeTab === "ia"} icon={<Network size={17} />} label="信息架构与优先级" onClick={() => setActiveTab("ia")} />
            <TabButton active={activeTab === "transcript"} icon={<MessageSquareText size={17} />} label="会议文字记录" onClick={() => setActiveTab("transcript")} />
          </div>

          <div className="document-card custom-scrollbar">
            {canRetrySummary && (
              <button className="upload-button" onClick={() => void retrySummary()}>
                重新生成需求纪要
              </button>
            )}
            {activeTab === "summary" && <MarkdownDocument content={summary || "## 处理中\n\nASR 完成后会自动生成需求分析纪要。"} />}
            {activeTab === "ia" && <MarkdownDocument content={ia} />}
            {activeTab === "transcript" && (
              <TranscriptPlayerDocument
                transcript={transcript}
                status={meeting?.status}
                audioUrl={audioUrl}
                durationSeconds={meeting?.audio_duration || meeting?.duration_seconds || 0}
              />
            )}
          </div>
        </section>

        <AgentSidebar
          canChat={canChat}
          chatMessages={chatMessages}
          chatInput={chatInput}
          isAiThinking={isAiThinking}
          onChangeChatInput={setChatInput}
          onSendMessage={() => void sendMessage()}
        />
      </section>
    </main>
  );
}
