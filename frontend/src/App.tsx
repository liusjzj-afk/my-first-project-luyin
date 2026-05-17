import { isValidElement, type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  Bot,
  BrainCircuit,
  CheckCircle2,
  FileAudio,
  FileText,
  Home,
  Layers3,
  Loader2,
  MessageSquareText,
  Mic2,
  Network,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  X
} from "lucide-react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

type TaskStatus = "PENDING" | "PROCESSING" | "SUMMARIZING" | "COMPLETED" | "FAILED";
type LibraryViewMode = "list" | "trash";
type DetailTab = "summary" | "ia" | "transcript";

type TranscriptItem = {
  speaker: string;
  start_time?: number;
  end_time?: number;
  startTime?: number;
  endTime?: number;
  text: string;
};

type TranscriptSegment = {
  speaker: string;
  startTime: number;
  endTime: number;
  text: string;
};

type MeetingStatus = {
  meeting_id: string;
  status: TaskStatus;
  title: string;
  upload_time?: string;
  duration_seconds?: number;
  audio_duration?: number;
  eta_seconds?: number | null;
  progress_percent?: number | null;
  audio_url?: string | null;
  transcript?: TranscriptItem[] | null;
  summary_markdown?: string | null;
  summary_content?: string | null;
  ia_content?: string | null;
  error?: string | null;
};

type MeetingListItem = {
  id: string;
  title: string;
  upload_time: string;
  asr_status: TaskStatus;
  duration_seconds: number;
  audio_duration: number;
  eta_seconds?: number | null;
  progress_percent?: number | null;
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

type UploadState = "idle" | "uploading" | "processing" | "summarizing" | "completed" | "failed";
type MermaidApi = typeof import("mermaid").default;

const defaultStats: MeetingStats = {
  used_minutes: 0,
  meeting_count: 0,
  processing_count: 0,
  trash_count: 0
};

let isMermaidConfigured = false;
let mermaidLoader: Promise<MermaidApi> | null = null;

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/meeting/:meetingId" element={<DetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function LibraryPage() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [viewMode, setViewMode] = useState<LibraryViewMode>("list");
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [stats, setStats] = useState<MeetingStats>(defaultStats);
  const [query, setQuery] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [statusText, setStatusText] = useState("等待上传会议音频");
  const [uploadProgress, setUploadProgress] = useState(0);

  useEffect(() => {
    void refreshLibrary(viewMode);
  }, [viewMode]);

  useEffect(() => {
    const hasActiveTask = meetings.some((item) => item.asr_status === "PROCESSING" || item.asr_status === "SUMMARIZING");
    if (!hasActiveTask && uploadState !== "processing" && uploadState !== "summarizing") return undefined;
    const timer = window.setInterval(() => void refreshLibrary(viewMode), 5000);
    return () => window.clearInterval(timer);
  }, [meetings, uploadState, viewMode]);

  const filteredMeetings = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return meetings;
    return meetings.filter((item) => item.title.toLowerCase().includes(keyword));
  }, [meetings, query]);

  const refreshLibrary = async (mode = viewMode) => {
    try {
      const [nextMeetings, nextStats] = await Promise.all([fetchMeetings(mode === "trash"), fetchStats()]);
      setMeetings(nextMeetings);
      setStats(nextStats);
    } catch (error) {
      console.error(error);
    }
  };

  const handleFileUpload = async (file: File) => {
    setUploadState("uploading");
    setStatusText("文件上传中...");
    setUploadProgress(18);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch(`${API_BASE_URL}/api/meetings/upload`, {
        method: "POST",
        body: formData
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as { meeting_id: string };
      const processingItem: MeetingListItem = {
        id: data.meeting_id,
        title: file.name,
        upload_time: new Date().toISOString(),
        asr_status: "PROCESSING",
        duration_seconds: 0,
        audio_duration: 0,
        eta_seconds: null,
        progress_percent: 28,
        deleted_at: null
      };
      setMeetings((items) => [processingItem, ...items.filter((item) => item.id !== data.meeting_id)]);
      setUploadState("processing");
      setStatusText("语音识别中，列表将自动刷新");
      setUploadProgress(35);
      setViewMode("list");
      void refreshLibrary("list");
    } catch (error) {
      setUploadState("failed");
      setUploadProgress(100);
      setStatusText(error instanceof Error ? error.message : "上传失败");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const deleteMeeting = async (meetingId: string) => {
    await mutateMeeting(`/api/meetings/${meetingId}`, "DELETE");
    await refreshLibrary("list");
  };

  const restoreMeeting = async (meetingId: string) => {
    await mutateMeeting(`/api/meetings/${meetingId}/restore`, "POST");
    await refreshLibrary("trash");
  };

  const purgeMeeting = async (meetingId: string) => {
    await mutateMeeting(`/api/meetings/${meetingId}/purge`, "DELETE");
    await refreshLibrary("trash");
  };

  return (
    <main className="premium-shell h-screen w-screen overflow-hidden">
      <aside className="premium-sidebar">
        <div className="brand-lockup">
          <div className="brand-orb">
            <BrainCircuit size={19} />
          </div>
          <div>
            <strong>SystemReq</strong>
            <span>Copilot</span>
          </div>
        </div>
        <nav className="premium-nav" aria-label="主导航">
          <button className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")}>
            <Home size={18} />
            我的内容
          </button>
          <button className={viewMode === "trash" ? "active" : ""} onClick={() => setViewMode("trash")}>
            <Trash2 size={18} />
            回收站
            {stats.trash_count > 0 && <em>{stats.trash_count}</em>}
          </button>
        </nav>
        <div className="signal-card">
          <span>空间概览</span>
          <strong>{stats.used_minutes} min</strong>
          <p>{stats.meeting_count} 个内容 · {stats.processing_count} 个处理中</p>
        </div>
      </aside>

      <section className="premium-main">
        <header className="premium-topbar">
          <div>
            <h1>{viewMode === "trash" ? "回收站" : "需求会议工作台"}</h1>
            <p>上传后停留在列表页，处理状态会在任务列中自动更新。</p>
          </div>
          <label className="premium-search">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会议、文件名" />
          </label>
        </header>

        <UploadDropzone
          inputRef={inputRef}
          isDragging={isDragging}
          uploadState={uploadState}
          statusText={statusText}
          uploadProgress={uploadProgress}
          onSetDragging={setIsDragging}
          onUpload={(file) => void handleFileUpload(file)}
        />

        <section className="library-panel">
          <div className="library-panel-head">
            <div>
              <span>{viewMode === "trash" ? "已删除" : "内容库"}</span>
              <h2>{viewMode === "trash" ? "已删除内容" : "会议任务列表"}</h2>
            </div>
            <button className="upload-button" onClick={() => inputRef.current?.click()}>
              <Upload size={17} />
              上传音频/视频
            </button>
          </div>
          <div className="meeting-grid custom-scrollbar" role="table" aria-label="会议列表">
            <div className="meeting-grid-head" role="row">
              <span>文件</span>
              <span>任务状态</span>
              <span>创建时间</span>
              <span>操作</span>
            </div>
            {filteredMeetings.length ? (
              filteredMeetings.map((item) => (
                <MeetingRow
                  key={item.id}
                  meeting={item}
                  isTrash={viewMode === "trash"}
                  onOpen={(meetingId) => navigate(`/meeting/${meetingId}`)}
                  onDelete={deleteMeeting}
                  onRestore={restoreMeeting}
                  onPurge={purgeMeeting}
                />
              ))
            ) : (
              <div className="empty-panel">{viewMode === "trash" ? "暂无删除内容" : "暂无内容，上传会议音频后会显示在这里。"}</div>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function UploadDropzone({
  inputRef,
  isDragging,
  uploadState,
  statusText,
  uploadProgress,
  onSetDragging,
  onUpload
}: {
  inputRef: RefObject<HTMLInputElement>;
  isDragging: boolean;
  uploadState: UploadState;
  statusText: string;
  uploadProgress: number;
  onSetDragging: (value: boolean) => void;
  onUpload: (file: File) => void;
}) {
  return (
    <div
      className={`premium-upload ${isDragging ? "dragging" : ""}`}
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
        accept=".mp3,.wav,.m4a,.mp4,.aac,.opus,audio/*,video/*"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onUpload(file);
        }}
      />
      <div className="upload-icon">
        <FileAudio size={22} />
      </div>
      <div>
        <strong>{statusText}</strong>
        <span>支持音频/视频文件。上传后不会自动跳转，可从列表手动查看详情。</span>
      </div>
      {uploadState !== "idle" && (
        <div className="upload-progress">
          <div style={{ width: `${uploadProgress}%` }} />
        </div>
      )}
    </div>
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
  return (
    <div className="meeting-grid-row" role="row">
      <div className="file-identity">
        <div className="file-glyph">
          <Mic2 size={21} />
        </div>
        <div>
          <strong>{meeting.title}</strong>
          <span>{formatDuration(meeting.audio_duration || meeting.duration_seconds)}</span>
        </div>
      </div>
      <TaskStatusCell meeting={meeting} />
      <time>{formatDateTime(meeting.upload_time)}</time>
      <div className="row-command">
        {!isTrash ? (
          <>
            <button className="detail-button" onClick={() => onOpen(meeting.id)}>查看详情</button>
            <button className="icon-button danger" aria-label="删除" onClick={() => onDelete(meeting.id)}>
              <Trash2 size={16} />
            </button>
          </>
        ) : (
          <>
            <button className="icon-button" aria-label="恢复" onClick={() => onRestore(meeting.id)}>
              <RotateCcw size={16} />
            </button>
            <button className="icon-button danger" aria-label="永久删除" onClick={() => onPurge(meeting.id)}>
              <X size={16} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function TaskStatusCell({ meeting }: { meeting: MeetingListItem }) {
  if (meeting.asr_status === "COMPLETED") {
    return (
      <div className="status-chip done">
        <CheckCircle2 size={15} />
        已完成
      </div>
    );
  }
  if (meeting.asr_status === "SUMMARIZING") return <div className="status-chip ai">AI 需求提取中...</div>;
  if (meeting.asr_status === "FAILED") return <div className="status-chip failed">识别失败</div>;
  if (meeting.asr_status === "PENDING") return <div className="status-chip pending">文件上传中...</div>;
  return (
    <div className="status-stack">
      <div className="task-progress">
        <div style={{ width: `${meeting.progress_percent ?? 35}%` }} />
      </div>
      <span>{formatProcessingText(meeting.eta_seconds)}</span>
    </div>
  );
}

function DetailPage() {
  const navigate = useNavigate();
  const { meetingId = "" } = useParams();
  const [meeting, setMeeting] = useState<MeetingStatus | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("summary");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isAiThinking, setIsAiThinking] = useState(false);

  useEffect(() => {
    if (!meetingId) return undefined;
    const load = async () => {
      const next = await fetchMeetingStatus(meetingId);
      setMeeting(next);
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [meetingId]);

  const transcript = meeting?.transcript || [];
  const canChat = meeting?.status === "COMPLETED" && transcript.length > 0;
  const summary = meeting?.summary_content || meeting?.summary_markdown || "";
  const ia = meeting?.ia_content || "## 暂无信息架构\n\n当前会议尚未生成信息架构与优先级内容。";
  const audioUrl = meeting?.audio_url ? resolveApiUrl(meeting.audio_url) : meetingId ? `${API_BASE_URL}/api/meetings/${meetingId}/audio` : "";

  const sendMessage = async () => {
    const message = chatInput.trim();
    if (!message || !meetingId || !canChat || isAiThinking) return;
    setChatInput("");
    setIsAiThinking(true);
    setChatMessages((items) => [...items, { role: "user", content: message }]);
    try {
      const response = await fetch(`${API_BASE_URL}/api/meetings/${meetingId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as { reply: string };
      setChatMessages((items) => [...items, { role: "assistant", content: data.reply }]);
    } catch (error) {
      setChatMessages((items) => [...items, { role: "assistant", content: error instanceof Error ? error.message : "发送失败" }]);
    } finally {
      setIsAiThinking(false);
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
          <span>{meeting?.upload_time ? formatDateTime(meeting.upload_time) : "读取会议数据"} · {formatDuration(meeting?.audio_duration || meeting?.duration_seconds || 0)}</span>
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

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={`tab-button transition-all duration-300 ${active ? "active" : ""}`} onClick={onClick} role="tab" aria-selected={active}>
      {icon}
      {label}
      <span />
    </button>
  );
}

function MarkdownDocument({ content }: { content: string }) {
  return (
    <article className="markdown-card prose prose-slate max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: MarkdownPre, code: MarkdownCode }}>
        {stripSectionMarkers(content)}
      </ReactMarkdown>
    </article>
  );
}

function MarkdownPre({ children }: { children?: React.ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children;
  if (isValidElement<{ className?: string }>(child) && child.props.className?.includes("language-mermaid")) {
    return <>{children}</>;
  }
  return <pre>{children}</pre>;
}

function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const language = /language-(\w+)/.exec(className || "")?.[1];
  const code = String(children || "").replace(/\n$/, "");
  if (language === "mermaid") {
    return <MermaidDiagram chart={code} />;
  }
  return <code className={className}>{children}</code>;
}

function MermaidDiagram({ chart }: { chart: string }) {
  const reactId = useId();
  const diagramId = useMemo(() => `meeting-ia-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}-${hashString(chart)}`, [chart, reactId]);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const source = chart.trim();
    let isCancelled = false;

    if (!source) {
      setSvg("");
      setError("图表内容为空");
      return undefined;
    }

    setSvg("");
    setError("");

    void loadMermaid()
      .then((mermaidApi) => mermaidApi.render(diagramId, source))
      .then((result) => {
        if (isCancelled) return;
        setSvg(result.svg);
      })
      .catch((renderError: unknown) => {
        if (isCancelled) return;
        setError(renderError instanceof Error ? renderError.message : "Mermaid 图表渲染失败");
      });

    return () => {
      isCancelled = true;
    };
  }, [chart, diagramId]);

  return (
    <div className="mermaid-panel" role="img" aria-label="信息架构图">
      <div className="mermaid-panel-chrome" aria-hidden="true">
        <span />
        <span />
        <span />
        <strong>IA RENDER</strong>
      </div>
      {error ? (
        <pre className="mermaid-error">{error}</pre>
      ) : svg ? (
        <div className="mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="mermaid-loading">图表渲染中...</div>
      )}
    </div>
  );
}

function TranscriptPlayerDocument({
  transcript,
  status,
  audioUrl,
  durationSeconds
}: {
  transcript: TranscriptItem[];
  status?: TaskStatus;
  audioUrl: string;
  durationSeconds: number;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const segments = useMemo(() => normalizeTranscriptSegments(transcript, durationSeconds), [durationSeconds, transcript]);
  const activeIndex = useMemo(
    () => findActiveTranscriptIndex(segments, currentTimeMs / 1000),
    [currentTimeMs, segments]
  );

  useEffect(() => {
    const player = audioRef.current;
    if (!player || !audioUrl) return;
    setCurrentTimeMs(0);
    player.load();
  }, [audioUrl]);

  const updateCurrentTime = useCallback((player: HTMLAudioElement) => {
    setCurrentTimeMs(player.currentTime * 1000);
  }, []);

  const playSegment = useCallback((segment: TranscriptSegment) => {
    const player = audioRef.current;
    const targetTime = Math.max(0, segment.startTime);
    if (!player || !audioUrl || !Number.isFinite(targetTime)) return;

    setCurrentTimeMs(targetTime * 1000);

    const seekAndPlay = () => {
      const hasDuration = Number.isFinite(player.duration) && player.duration > 0;
      const maxSeekTime = hasDuration ? Math.max(0, player.duration - 0.05) : targetTime;
      const nextTime = Math.min(targetTime, maxSeekTime);

      player.currentTime = nextTime;
      updateCurrentTime(player);
      void player.play().catch(() => undefined);
    };

    if (player.readyState >= HTMLMediaElement.HAVE_METADATA) {
      seekAndPlay();
      return;
    }

    player.addEventListener("loadedmetadata", seekAndPlay, { once: true });
    player.load();
  }, [audioUrl, updateCurrentTime]);

  if (!segments.length) {
    return <div className="empty-panel">{status === "FAILED" ? "识别失败，暂无逐字稿。" : "识别完成后，逐字稿会显示在这里。"}</div>;
  }

  return (
    <div className="transcript-sync-panel">
      <div className="audio-player-card">
        <div>
          <strong>会议录音</strong>
          <span>{activeIndex >= 0 ? `正在定位第 ${activeIndex + 1} 段文字` : "点击文字可跳转播放位置"}</span>
        </div>
        <audio
          ref={audioRef}
          controls
          preload="metadata"
          src={audioUrl}
          onLoadedMetadata={(event) => updateCurrentTime(event.currentTarget)}
          onTimeUpdate={(event) => updateCurrentTime(event.currentTarget)}
          onSeeked={(event) => updateCurrentTime(event.currentTarget)}
        />
      </div>

      <TranscriptDocument
        transcript={segments}
        activeIndex={activeIndex}
        onSelectSegment={playSegment}
      />
    </div>
  );
}

function TranscriptDocument({
  transcript,
  activeIndex,
  onSelectSegment
}: {
  transcript: TranscriptSegment[];
  activeIndex: number;
  onSelectSegment: (segment: TranscriptSegment) => void;
}) {
  if (!transcript.length) {
    return null;
  }

  return (
    <div className="transcript-document">
      {transcript.map((item, index) => (
        <button
          type="button"
          key={`${item.speaker}-${item.startTime}-${index}`}
          className={`transcript-entry ${activeIndex === index ? "active" : ""}`}
          data-start-time={item.startTime}
          aria-current={activeIndex === index ? "true" : undefined}
          aria-label={`跳转到 ${formatSeconds(item.startTime)} 的文字记录`}
          onClick={() => onSelectSegment(item)}
        >
          <div className="speaker-token">{item.speaker.replace("spk_", "")}</div>
          <div>
            <div className="transcript-meta">
              <strong>{item.speaker}</strong>
              <time>{formatSeconds(item.startTime)}-{formatSeconds(item.endTime)}</time>
            </div>
            <p>{item.text}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

function AgentSidebar({
  canChat,
  chatMessages,
  chatInput,
  isAiThinking,
  onChangeChatInput,
  onSendMessage
}: {
  canChat: boolean;
  chatMessages: ChatMessage[];
  chatInput: string;
  isAiThinking: boolean;
  onChangeChatInput: (value: string) => void;
  onSendMessage: () => void;
}) {
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

function StatusBadge({ status }: { status: TaskStatus }) {
  const labelMap: Record<TaskStatus, string> = {
    PENDING: "文件上传中",
    PROCESSING: "语音识别中",
    SUMMARIZING: "AI 提取中",
    COMPLETED: "已完成",
    FAILED: "失败"
  };
  return <span className={`detail-status ${status.toLowerCase()}`}>{labelMap[status]}</span>;
}

async function loadMermaid() {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then(({ default: mermaidApi }) => {
      configureMermaid(mermaidApi);
      return mermaidApi;
    });
  }
  return mermaidLoader;
}

function configureMermaid(mermaidApi: MermaidApi) {
  if (isMermaidConfigured) return;
  mermaidApi.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "dark",
    maxTextSize: 100000,
    themeVariables: {
      background: "#071016",
      primaryColor: "#dffefa",
      primaryTextColor: "#082025",
      primaryBorderColor: "#00ffcc",
      lineColor: "#35d8ff",
      secondaryColor: "#d8f7ff",
      secondaryTextColor: "#082025",
      tertiaryColor: "#ecfffb",
      tertiaryTextColor: "#082025",
      edgeLabelBackground: "#0b1118",
      clusterBkg: "#0f172a",
      clusterBorder: "#00ffcc",
      fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Inter, sans-serif",
      noteBkgColor: "#0f172a",
      noteTextColor: "#dffefa",
      noteBorderColor: "#35d8ff"
    },
    flowchart: {
      curve: "basis",
      htmlLabels: false,
      padding: 20,
      nodeSpacing: 44,
      rankSpacing: 64,
      useMaxWidth: true
    }
  });
  isMermaidConfigured = true;
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function resolveApiUrl(pathOrUrl: string) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${API_BASE_URL}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

function stripSectionMarkers(content: string) {
  return content
    .replace(/<!--\s*(?:SUMMARY|IA)_(?:START|END)\s*-->/gi, "")
    .trim();
}

function normalizeTranscriptSegments(transcript: TranscriptItem[], durationSeconds: number): TranscriptSegment[] {
  return transcript.map((item, index) => {
    const startTime = readTranscriptTimeSeconds(item, "start", durationSeconds);
    const explicitEndTime = readTranscriptTimeSeconds(item, "end", durationSeconds);
    const nextStartTime = transcript[index + 1] ? readTranscriptTimeSeconds(transcript[index + 1], "start", durationSeconds) : 0;
    const fallbackEndTime = nextStartTime > startTime ? nextStartTime : durationSeconds > startTime ? durationSeconds : startTime;
    const endTime = explicitEndTime > startTime ? explicitEndTime : fallbackEndTime;

    return {
      speaker: item.speaker || "未知说话人",
      startTime,
      endTime,
      text: item.text
    };
  });
}

function readTranscriptTimeSeconds(item: TranscriptItem, boundary: "start" | "end", durationSeconds: number) {
  const snakeValue = boundary === "start" ? item.start_time : item.end_time;
  if (typeof snakeValue === "number") {
    return Math.max(0, snakeValue / 1000);
  }

  const camelValue = boundary === "start" ? item.startTime : item.endTime;
  return normalizeFlexibleTimeValue(camelValue, durationSeconds);
}

function normalizeFlexibleTimeValue(value: number | undefined, durationSeconds: number) {
  const safeValue = Math.max(0, Number(value || 0));
  if (!Number.isFinite(safeValue) || safeValue <= 0) return 0;

  const durationWithTolerance = Math.max(0, durationSeconds) + 5;
  if (durationSeconds > 0) {
    if (safeValue <= durationWithTolerance) return safeValue;
    if (safeValue / 1000 <= durationWithTolerance) return safeValue / 1000;
  }

  return safeValue > 24 * 60 * 60 ? safeValue / 1000 : safeValue;
}

function findActiveTranscriptIndex(
  transcript: TranscriptSegment[],
  currentTime: number
) {
  if (!transcript.length) return -1;
  return transcript.findIndex((item, index) => {
    const nextStart = transcript[index + 1]?.startTime ?? Number.POSITIVE_INFINITY;
    const endTime = item.endTime || nextStart;
    return currentTime >= item.startTime && currentTime < Math.max(endTime, nextStart, item.startTime + 0.001);
  });
}

function formatSeconds(value: number) {
  return formatTime(value * 1000);
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
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const rest = safeSeconds % 60;
  if (hours) return `${hours} 小时 ${minutes} 分 ${rest} 秒`;
  if (minutes) return `${minutes} 分 ${rest} 秒`;
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

function formatProcessingText(etaSeconds?: number | null) {
  if (!etaSeconds) return "语音识别中，预计还需计算中";
  const minutes = Math.floor(etaSeconds / 60);
  const seconds = etaSeconds % 60;
  return `语音识别中，预计还需 ${minutes} 分 ${seconds} 秒`;
}

export default App;
