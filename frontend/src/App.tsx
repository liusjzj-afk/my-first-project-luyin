import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  ArrowLeft,
  Bot,
  Check,
  Clipboard,
  FileAudio,
  FileText,
  Home,
  Loader2,
  Mic2,
  MoreHorizontal,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  UsersRound,
  X
} from "lucide-react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

type TranscriptItem = {
  speaker: string;
  start_time: number;
  end_time?: number;
  text: string;
};

type MeetingStatus = {
  meeting_id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  title: string;
  upload_time?: string;
  duration_seconds?: number;
  transcript?: TranscriptItem[] | null;
  summary_markdown?: string | null;
  error?: string | null;
};

type MeetingListItem = {
  id: string;
  title: string;
  upload_time: string;
  asr_status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  duration_seconds: number;
  deleted_at?: string | null;
};

type MeetingStats = {
  used_minutes: number;
  meeting_count: number;
  processing_count: number;
  trash_count: number;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type UploadState = "idle" | "uploading" | "processing" | "completed" | "failed";
type ActiveView = "library" | "trash" | "detail";
type DetailPanel = "summary" | "speakers";

const defaultStats: MeetingStats = {
  used_minutes: 0,
  meeting_count: 0,
  processing_count: 0,
  trash_count: 0
};

const speakerColors = [
  "bg-[#4f7cff]",
  "bg-[#29c7a6]",
  "bg-[#39bdf8]",
  "bg-[#8057f5]",
  "bg-[#d75bd5]",
  "bg-[#f4a340]"
];

function App() {
  const [activeView, setActiveView] = useState<ActiveView>("library");
  const [currentMeetingId, setCurrentMeetingId] = useState<string>("");
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [stats, setStats] = useState<MeetingStats>(defaultStats);
  const [meeting, setMeeting] = useState<MeetingStatus | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [statusText, setStatusText] = useState("等待上传会议音频");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [query, setQuery] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [detailPanel, setDetailPanel] = useState<DetailPanel>("summary");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const transcript = meeting?.transcript || [];
  const summary = meeting?.summary_markdown || "";
  const isTrashView = activeView === "trash";

  useEffect(() => {
    void refreshLibrary(isTrashView);
  }, [isTrashView]);

  useEffect(() => {
    if (!currentMeetingId || uploadState !== "processing") {
      return undefined;
    }

    const poll = async () => {
      try {
        const next = await fetchMeetingStatus(currentMeetingId);
        setMeeting(next);

        if (next.status === "COMPLETED") {
          setUploadState("completed");
          setUploadProgress(100);
          setStatusText("需求纪要已生成");
          void refreshLibrary(false);
        } else if (next.status === "FAILED") {
          setUploadState("failed");
          setUploadProgress(100);
          setStatusText(next.error || "处理失败，请检查服务配置");
          void refreshLibrary(false);
        } else {
          setUploadProgress((value) => Math.min(value + 8, 88));
          setStatusText("识别中...");
        }
      } catch (error) {
        setUploadState("failed");
        setStatusText(error instanceof Error ? error.message : "状态查询失败");
      }
    };

    poll();
    const timer = window.setInterval(poll, 5000);
    return () => window.clearInterval(timer);
  }, [currentMeetingId, uploadState]);

  const filteredMeetings = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return meetings;
    return meetings.filter((item) => item.title.toLowerCase().includes(keyword));
  }, [meetings, query]);

  const speakerColorMap = useMemo(() => {
    const map = new Map<string, string>();
    transcript.forEach((item) => {
      if (!map.has(item.speaker)) {
        map.set(item.speaker, speakerColors[map.size % speakerColors.length]);
      }
    });
    return map;
  }, [transcript]);

  const speakerStats = useMemo(() => {
    const counts = new Map<string, number>();
    transcript.forEach((item) => counts.set(item.speaker, (counts.get(item.speaker) || 0) + 1));
    return Array.from(counts.entries()).map(([speaker, count]) => ({ speaker, count }));
  }, [transcript]);

  const refreshLibrary = async (trash = false) => {
    try {
      const [nextMeetings, nextStats] = await Promise.all([
        fetchMeetings(trash),
        fetchStats()
      ]);
      setMeetings(nextMeetings);
      setStats(nextStats);
    } catch (error) {
      setMeetings([]);
      setStats(defaultStats);
      console.error(error);
    }
  };

  const openMeeting = async (meetingId: string) => {
    setCurrentMeetingId(meetingId);
    const next = await fetchMeetingStatus(meetingId);
    setMeeting(next);
    setUploadState(next.status === "COMPLETED" ? "completed" : next.status === "FAILED" ? "failed" : "processing");
    setStatusText(next.error || statusLabel(next.status));
    setUploadProgress(next.status === "COMPLETED" || next.status === "FAILED" ? 100 : 52);
    setChatMessages([]);
    setDetailPanel("summary");
    setActiveView("detail");
  };

  const handleFileUpload = async (file: File) => {
    if (!file) return;
    setUploadState("uploading");
    setStatusText("正在上传...");
    setUploadProgress(18);
    setMeeting({
      meeting_id: "",
      status: "PROCESSING",
      title: file.name,
      transcript: null,
      summary_markdown: null
    });
    setChatMessages([]);
    setActiveView("detail");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch(`${API_BASE_URL}/api/meetings/upload`, {
        method: "POST",
        body: formData
      });
      if (!response.ok) {
        const detail = await readError(response);
        throw new Error(detail);
      }

      const data = (await response.json()) as { meeting_id: string; status: string };
      setCurrentMeetingId(data.meeting_id);
      setUploadState("processing");
      setUploadProgress(42);
      setStatusText("识别中...");
      void refreshLibrary(false);
    } catch (error) {
      setUploadState("failed");
      setStatusText(error instanceof Error ? error.message : "上传失败");
      setUploadProgress(100);
    }
  };

  const deleteMeeting = async (meetingId: string) => {
    await mutateMeeting(`/api/meetings/${meetingId}`, "DELETE");
    await refreshLibrary(false);
  };

  const restoreMeeting = async (meetingId: string) => {
    await mutateMeeting(`/api/meetings/${meetingId}/restore`, "POST");
    await refreshLibrary(true);
  };

  const purgeMeeting = async (meetingId: string) => {
    await mutateMeeting(`/api/meetings/${meetingId}/purge`, "DELETE");
    await refreshLibrary(true);
  };

  const sendMessage = async () => {
    const message = chatInput.trim();
    if (!message || !currentMeetingId || isSending) return;

    setChatInput("");
    setIsSending(true);
    setChatMessages((items) => [...items, { role: "user", content: message }]);

    try {
      const response = await fetch(`${API_BASE_URL}/api/meetings/${currentMeetingId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      if (!response.ok) {
        const detail = await readError(response);
        throw new Error(detail);
      }

      const data = (await response.json()) as { reply: string };
      setChatMessages((items) => [...items, { role: "assistant", content: data.reply }]);
    } catch (error) {
      const fallback = error instanceof Error ? error.message : "发送失败";
      setChatMessages((items) => [...items, { role: "assistant", content: fallback }]);
    } finally {
      setIsSending(false);
    }
  };

  const copySummary = async () => {
    if (!summary) return;
    await navigator.clipboard.writeText(summary);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  if (activeView === "detail") {
    return (
      <MeetingDetailView
        meeting={meeting}
        transcript={transcript}
        speakerStats={speakerStats}
        speakerColorMap={speakerColorMap}
        detailPanel={detailPanel}
        uploadState={uploadState}
        statusText={statusText}
        uploadProgress={uploadProgress}
        copied={copied}
        chatMessages={chatMessages}
        chatInput={chatInput}
        isSending={isSending}
        onBack={() => {
          setActiveView("library");
          void refreshLibrary(false);
        }}
        onChangePanel={setDetailPanel}
        onCopySummary={() => void copySummary()}
        onChangeChatInput={setChatInput}
        onSendMessage={() => void sendMessage()}
      />
    );
  }

  return (
    <LibraryView
      activeView={activeView}
      meetings={filteredMeetings}
      stats={stats}
      query={query}
      uploadState={uploadState}
      statusText={statusText}
      uploadProgress={uploadProgress}
      isDragging={isDragging}
      inputRef={inputRef}
      onSetView={setActiveView}
      onSetQuery={setQuery}
      onSetDragging={setIsDragging}
      onUpload={(file) => void handleFileUpload(file)}
      onOpen={(meetingId) => void openMeeting(meetingId)}
      onDelete={(meetingId) => void deleteMeeting(meetingId)}
      onRestore={(meetingId) => void restoreMeeting(meetingId)}
      onPurge={(meetingId) => void purgeMeeting(meetingId)}
    />
  );
}

function LibraryView({
  activeView,
  meetings,
  stats,
  query,
  uploadState,
  statusText,
  uploadProgress,
  isDragging,
  inputRef,
  onSetView,
  onSetQuery,
  onSetDragging,
  onUpload,
  onOpen,
  onDelete,
  onRestore,
  onPurge
}: {
  activeView: ActiveView;
  meetings: MeetingListItem[];
  stats: MeetingStats;
  query: string;
  uploadState: UploadState;
  statusText: string;
  uploadProgress: number;
  isDragging: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  onSetView: (view: ActiveView) => void;
  onSetQuery: (value: string) => void;
  onSetDragging: (value: boolean) => void;
  onUpload: (file: File) => void;
  onOpen: (meetingId: string) => void;
  onDelete: (meetingId: string) => void;
  onRestore: (meetingId: string) => void;
  onPurge: (meetingId: string) => void;
}) {
  const isTrash = activeView === "trash";

  return (
    <main className="library-shell">
      <aside className="library-sidebar">
        <div className="brand-mark">
          <div className="brand-symbol">M</div>
          <span>会议纪要</span>
        </div>

        <nav className="side-nav" aria-label="主导航">
          <button className="side-nav-item" onClick={() => onSetView("library")}>
            <Home size={18} />
            <span>主页</span>
          </button>
          <button
            className={`side-nav-item ${!isTrash ? "active" : ""}`}
            onClick={() => onSetView("library")}
          >
            <FileText size={18} />
            <span>我的内容</span>
          </button>
          <button
            className={`side-nav-item ${isTrash ? "active" : ""}`}
            onClick={() => onSetView("trash")}
          >
            <Trash2 size={18} />
            <span>回收站</span>
            {stats.trash_count > 0 && <span className="nav-count">{stats.trash_count}</span>}
          </button>
        </nav>

        <div className="usage-card">
          <div className="usage-title">已用分钟</div>
          <div className="usage-value">{stats.used_minutes} 分钟</div>
          <div className="usage-row">
            <span>内容数量</span>
            <strong>{stats.meeting_count}</strong>
          </div>
          <div className="usage-row">
            <span>处理中</span>
            <strong>{stats.processing_count}</strong>
          </div>
        </div>
      </aside>

      <section className="library-main">
        <header className="library-topbar">
          <label className="search-box">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => onSetQuery(event.target.value)}
              placeholder="搜索妙记"
            />
          </label>
          <div className="topbar-actions">
            <button className="primary-button" onClick={() => inputRef.current?.click()}>
              <Mic2 size={17} />
              <span>录音</span>
            </button>
            <button className="secondary-button" onClick={() => inputRef.current?.click()}>
              <Upload size={17} />
              <span>上传</span>
            </button>
          </div>
        </header>

        <div
          className={`library-upload-strip ${isDragging ? "dragging" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            onSetDragging(true);
          }}
          onDragLeave={() => onSetDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            onSetDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) onUpload(file);
          }}
        >
          <input
            ref={inputRef}
            className="hidden"
            type="file"
            accept=".mp3,.wav,.m4a,audio/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUpload(file);
            }}
          />
          <FileAudio size={20} />
          <div>
            <strong>{statusText}</strong>
            <span>支持 MP3 / WAV / M4A，最大 100 MB</span>
          </div>
          {uploadState !== "idle" && (
            <div className="mini-progress" aria-label="上传和识别进度">
              <div style={{ width: `${uploadProgress}%` }} />
            </div>
          )}
        </div>

        <div className="content-header">
          <h1>{isTrash ? "回收站" : "我的内容"}</h1>
        </div>

        <div className="meeting-table" role="table" aria-label={isTrash ? "回收站列表" : "我的内容列表"}>
          <div className="meeting-table-head" role="row">
            <span>文件</span>
            <span>创建时间</span>
            <span>操作</span>
          </div>
          {meetings.length ? (
            meetings.map((item) => (
              <MeetingRow
                key={item.id}
                meeting={item}
                isTrash={isTrash}
                onOpen={onOpen}
                onDelete={onDelete}
                onRestore={onRestore}
                onPurge={onPurge}
              />
            ))
          ) : (
            <div className="table-empty">
              {isTrash ? "暂无删除内容" : "暂无内容，上传会议音频后会显示在这里。"}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function MeetingRow({
  meeting,
  isTrash,
  onOpen,
  onDelete,
  onRestore,
  onPurge
}: {
  meeting: MeetingListItem;
  isTrash: boolean;
  onOpen: (meetingId: string) => void;
  onDelete: (meetingId: string) => void;
  onRestore: (meetingId: string) => void;
  onPurge: (meetingId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="meeting-table-row" role="row">
      <button className="file-cell" onClick={() => !isTrash && onOpen(meeting.id)}>
        <span className="file-thumb">
          <Mic2 size={24} />
        </span>
        <span className="file-meta">
          <strong>{meeting.title}</strong>
          <span>{formatDuration(meeting.duration_seconds)} · {statusLabel(meeting.asr_status)}</span>
        </span>
      </button>
      <time>{formatDateTime(meeting.upload_time)}</time>
      <div className="row-actions">
        <button
          className="icon-action"
          aria-label="更多操作"
          onClick={() => setOpen((value) => !value)}
        >
          <MoreHorizontal size={18} />
        </button>
        {open && (
          <div className="action-menu">
            {!isTrash ? (
              <>
                <button onClick={() => onOpen(meeting.id)}>
                  <FileText size={16} />
                  打开
                </button>
                <button className="danger" onClick={() => onDelete(meeting.id)}>
                  <Trash2 size={16} />
                  删除
                </button>
              </>
            ) : (
              <>
                <button onClick={() => onRestore(meeting.id)}>
                  <RotateCcw size={16} />
                  恢复
                </button>
                <button className="danger" onClick={() => onPurge(meeting.id)}>
                  <X size={16} />
                  永久删除
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MeetingDetailView({
  meeting,
  transcript,
  speakerStats,
  speakerColorMap,
  detailPanel,
  uploadState,
  statusText,
  uploadProgress,
  copied,
  chatMessages,
  chatInput,
  isSending,
  onBack,
  onChangePanel,
  onCopySummary,
  onChangeChatInput,
  onSendMessage
}: {
  meeting: MeetingStatus | null;
  transcript: TranscriptItem[];
  speakerStats: Array<{ speaker: string; count: number }>;
  speakerColorMap: Map<string, string>;
  detailPanel: DetailPanel;
  uploadState: UploadState;
  statusText: string;
  uploadProgress: number;
  copied: boolean;
  chatMessages: ChatMessage[];
  chatInput: string;
  isSending: boolean;
  onBack: () => void;
  onChangePanel: (panel: DetailPanel) => void;
  onCopySummary: () => void;
  onChangeChatInput: (value: string) => void;
  onSendMessage: () => void;
}) {
  const summary = meeting?.summary_markdown || "";
  const canChat = meeting?.status === "COMPLETED" && transcript.length > 0;

  return (
    <main className="detail-shell">
      <header className="detail-topbar">
        <button className="back-button" onClick={onBack} aria-label="返回列表">
          <ArrowLeft size={20} />
        </button>
        <div className="detail-title">
          <h1>{meeting?.title || "会议处理中"}</h1>
          <p>
            {meeting?.upload_time ? formatDateTime(meeting.upload_time) : "刚刚上传"} · {formatDuration(meeting?.duration_seconds || 0)}
          </p>
        </div>
        <div className="detail-actions">
          <StatusPill state={uploadState} />
          <button className="secondary-button" disabled>
            分享
          </button>
          <button className="icon-action" aria-label="更多操作">
            <MoreHorizontal size={18} />
          </button>
        </div>
      </header>

      <section className="detail-grid">
        <aside className="summary-pane">
          <div className="detail-tabs">
            <button
              className={detailPanel === "summary" ? "active" : ""}
              onClick={() => onChangePanel("summary")}
            >
              <Sparkles size={16} />
              智能纪要
            </button>
            <button
              className={detailPanel === "speakers" ? "active" : ""}
              onClick={() => onChangePanel("speakers")}
            >
              <UsersRound size={16} />
              发言人
            </button>
          </div>

          {detailPanel === "summary" ? (
            <div className="summary-content">
              <div className="summary-toolbar">
                <h2>会议纪要</h2>
                <button
                  className="icon-action"
                  aria-label="复制纪要"
                  disabled={!summary}
                  onClick={onCopySummary}
                >
                  {copied ? <Check size={17} /> : <Clipboard size={17} />}
                </button>
              </div>
              {summary ? (
                <div className="markdown-body">
                  <ReactMarkdown>{summary}</ReactMarkdown>
                </div>
              ) : (
                <EmptyBlock text={meeting?.status === "FAILED" ? statusText : "ASR 完成后会自动生成 Markdown 纪要。"} />
              )}
            </div>
          ) : (
            <div className="speaker-list">
              {speakerStats.length ? (
                speakerStats.map((item) => (
                  <div key={item.speaker} className="speaker-row">
                    <span className={`speaker-dot ${speakerColorMap.get(item.speaker) || speakerColors[0]}`} />
                    <strong>{item.speaker}</strong>
                    <span>{item.count} 段发言</span>
                  </div>
                ))
              ) : (
                <EmptyBlock text="暂无发言人信息。" />
              )}
            </div>
          )}
        </aside>

        <section className="transcript-pane">
          <div className="pane-title">
            <h2>文字记录</h2>
            <span>{transcript.length} 条</span>
          </div>
          <div className="transcript-scroll">
            {transcript.length ? (
              transcript.map((item, index) => (
                <TranscriptLine
                  key={`${item.speaker}-${item.start_time}-${index}`}
                  item={item}
                  color={speakerColorMap.get(item.speaker) || speakerColors[0]}
                />
              ))
            ) : (
              <EmptyBlock text={meeting?.status === "FAILED" ? statusText : "识别完成后，逐字稿会显示在这里。"} />
            )}
          </div>
          <div className="audio-bar">
            <div className="audio-progress">
              <div style={{ width: `${uploadProgress}%` }} />
            </div>
            <div className="audio-controls">
              <button className="play-button" aria-label="播放占位" disabled>
                <span />
              </button>
              <strong>{formatDuration(0)} / {formatDuration(meeting?.duration_seconds || 0)}</strong>
              <span>1x</span>
              <MoreHorizontal size={18} />
            </div>
          </div>
        </section>

        <aside className="agent-pane">
          <div className="agent-header">
            <Bot size={18} />
            <strong>大模型提问</strong>
          </div>
          <div className="agent-body">
            {chatMessages.length ? (
              chatMessages.map((message, index) => (
                <ChatBubble key={`${message.role}-${index}`} message={message} />
              ))
            ) : (
              <div className="agent-empty">
                <Bot size={30} />
                <h2>Hi，问点什么</h2>
                <p>知识范围：当前会议逐字稿与智能纪要</p>
                <QuestionHint text="不同发言人分别表达了什么观点？" />
                <QuestionHint text="这场会议有哪些待办事项？" />
                <QuestionHint text="有哪些未确认的问题？" />
              </div>
            )}
          </div>
          <div className="agent-input-wrap">
            {!canChat && <p className="input-hint">{meeting?.status === "FAILED" ? statusText : "会议完成后可提问"}</p>}
            <div className="agent-input">
              <textarea
                value={chatInput}
                rows={2}
                disabled={!canChat}
                onChange={(event) => onChangeChatInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    onSendMessage();
                  }
                }}
                placeholder="问个问题，或用妙记写点内容"
              />
              <button
                className="send-button"
                aria-label="发送"
                disabled={!chatInput.trim() || !canChat || isSending}
                onClick={onSendMessage}
              >
                {isSending ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
              </button>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

function TranscriptLine({ item, color }: { item: TranscriptItem; color: string }) {
  return (
    <article className="transcript-line">
      <div className={`speaker-avatar ${color}`}>{item.speaker.replace("spk_", "")}</div>
      <div>
        <div className="transcript-meta">
          <strong>{item.speaker}</strong>
          <time>{formatTime(item.start_time)}</time>
        </div>
        <p>{item.text}</p>
      </div>
    </article>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`chat-bubble-row ${isUser ? "user" : "assistant"}`}>
      <div className="chat-avatar">{isUser ? <UserRound size={15} /> : <Bot size={15} />}</div>
      <div className="chat-bubble">{message.content}</div>
    </div>
  );
}

function QuestionHint({ text }: { text: string }) {
  return (
    <button className="question-hint" disabled>
      <Sparkles size={16} />
      <span>{text}</span>
    </button>
  );
}

function StatusPill({ state }: { state: UploadState }) {
  const labelMap: Record<UploadState, string> = {
    idle: "待上传",
    uploading: "上传中",
    processing: "处理中",
    completed: "已完成",
    failed: "失败"
  };
  return <span className={`status-pill ${state}`}>{labelMap[state]}</span>;
}

function EmptyBlock({ text }: { text: string }) {
  return <div className="empty-block">{text}</div>;
}

async function fetchMeetings(trash = false): Promise<MeetingListItem[]> {
  const response = await fetch(`${API_BASE_URL}/api/meetings?trash=${trash}`);
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

async function fetchStats(): Promise<MeetingStats> {
  const response = await fetch(`${API_BASE_URL}/api/meetings/stats`);
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

async function fetchMeetingStatus(meetingId: string): Promise<MeetingStatus> {
  const response = await fetch(`${API_BASE_URL}/api/meetings/${meetingId}/status`);
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

async function mutateMeeting(path: string, method: "DELETE" | "POST") {
  const response = await fetch(`${API_BASE_URL}${path}`, { method });
  if (!response.ok) throw new Error(await readError(response));
}

async function readError(response: Response) {
  try {
    const body = await response.json();
    return body.detail || "请求失败";
  } catch {
    return "请求失败";
  }
}

function formatTime(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const rest = safeSeconds % 60;
  if (hours) {
    return `${hours} 小时 ${minutes} 分 ${rest} 秒`;
  }
  if (minutes) {
    return `${minutes} 分 ${rest} 秒`;
  }
  return `${rest} 秒`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function statusLabel(status: MeetingStatus["status"] | MeetingListItem["asr_status"]) {
  const labels = {
    PENDING: "待处理",
    PROCESSING: "识别中",
    COMPLETED: "已完成",
    FAILED: "失败"
  };
  return labels[status];
}

export default App;
