import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Bot,
  Check,
  Clipboard,
  Loader2,
  Mic2,
  Send,
  UploadCloud,
  UserRound
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
  transcript?: TranscriptItem[] | null;
  summary_markdown?: string | null;
  error?: string | null;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type UploadState = "idle" | "uploading" | "processing" | "completed" | "failed";

const speakerColors = [
  "bg-cyan-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-indigo-500",
  "bg-slate-500"
];

function App() {
  const [currentMeetingId, setCurrentMeetingId] = useState<string>("");
  const [meeting, setMeeting] = useState<MeetingStatus | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [statusText, setStatusText] = useState("等待上传会议音频");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const transcript = meeting?.transcript || [];
  const summary = meeting?.summary_markdown || "";

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
        } else if (next.status === "FAILED") {
          setUploadState("failed");
          setStatusText(next.error || "处理失败，请检查服务配置");
        } else {
          setStatusText(next.transcript?.length ? "提取需求中..." : "识别中...");
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

  const speakerColorMap = useMemo(() => {
    const map = new Map<string, string>();
    transcript.forEach((item) => {
      if (!map.has(item.speaker)) {
        map.set(item.speaker, speakerColors[map.size % speakerColors.length]);
      }
    });
    return map;
  }, [transcript]);

  const handleFileUpload = async (file: File) => {
    if (!file) return;
    setUploadState("uploading");
    setStatusText("正在上传...");
    setUploadProgress(18);
    setMeeting(null);
    setChatMessages([]);

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
    } catch (error) {
      setUploadState("failed");
      setStatusText(error instanceof Error ? error.message : "上传失败");
      setUploadProgress(0);
    }
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

  return (
    <main className="min-h-screen bg-[#f6f8fb] text-slate-950">
      <div className="mx-auto grid min-h-screen max-w-[1720px] gap-4 p-4 lg:grid-cols-[40%_60%]">
        <section className="panel flex min-h-[calc(100vh-32px)] flex-col overflow-hidden">
          <div className="border-b border-slate-200 p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-white">
                  <Mic2 size={18} />
                </div>
                <div>
                  <h1 className="text-base font-semibold">SystemReq-Copilot</h1>
                  <p className="text-xs text-slate-500">{meeting?.title || "会议需求智能提取系统"}</p>
                </div>
              </div>
              <StatusPill state={uploadState} />
            </div>

            <div
              className={`upload-zone ${isDragging ? "border-cyan-500 bg-cyan-50" : ""}`}
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                const file = event.dataTransfer.files[0];
                if (file) void handleFileUpload(file);
              }}
            >
              <input
                ref={inputRef}
                className="hidden"
                type="file"
                accept=".mp3,.wav,.m4a,audio/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFileUpload(file);
                }}
              />
              <UploadCloud className="text-slate-600" size={24} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">拖拽或点击上传音频</p>
                <p className="text-xs text-slate-500">MP3 / WAV / M4A，最大 100 MB</p>
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="text-slate-500">{statusText}</span>
                <span className="font-medium text-slate-700">{uploadProgress}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-cyan-500 transition-all duration-500"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-semibold">逐字稿</h2>
              <span className="text-xs text-slate-500">{transcript.length} 条</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {transcript.length ? (
                <div className="space-y-3">
                  {transcript.map((item, index) => (
                    <TranscriptBubble
                      key={`${item.speaker}-${item.start_time}-${index}`}
                      item={item}
                      color={speakerColorMap.get(item.speaker) || speakerColors[0]}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState text="上传会议音频后，逐字稿会显示在这里。" />
              )}
            </div>
          </div>
        </section>

        <section className="grid min-h-[calc(100vh-32px)] gap-4 lg:grid-rows-[60%_40%]">
          <article className="panel flex min-h-0 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="text-base font-semibold">系统需求分析纪要</h2>
              <button
                className="icon-button"
                title="复制纪要"
                disabled={!summary}
                onClick={() => void copySummary()}
              >
                {copied ? <Check size={17} /> : <Clipboard size={17} />}
              </button>
            </div>
            <div className="markdown-body min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {summary ? <ReactMarkdown>{summary}</ReactMarkdown> : <EmptyState text="ASR 完成后会自动生成 Markdown 纪要。" />}
            </div>
          </article>

          <article className="panel flex min-h-0 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h2 className="text-base font-semibold">Agent 互动窗口</h2>
              {isSending ? <Loader2 className="animate-spin text-cyan-600" size={17} /> : <Bot className="text-slate-500" size={17} />}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {chatMessages.length ? (
                <div className="space-y-3">
                  {chatMessages.map((message, index) => (
                    <ChatBubble key={`${message.role}-${index}`} message={message} />
                  ))}
                </div>
              ) : (
                <EmptyState text="会议完成后，可以追问任意会议细节。" />
              )}
            </div>

            <div className="border-t border-slate-200 p-4">
              <div className="flex items-end gap-2">
                <textarea
                  value={chatInput}
                  rows={2}
                  disabled={!currentMeetingId || uploadState !== "completed"}
                  onChange={(event) => setChatInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                  className="chat-input"
                  placeholder="输入关于本次会议的问题"
                />
                <button
                  className="send-button"
                  title="发送"
                  disabled={!chatInput.trim() || !currentMeetingId || uploadState !== "completed" || isSending}
                  onClick={() => void sendMessage()}
                >
                  <Send size={18} />
                </button>
              </div>
            </div>
          </article>
        </section>
      </div>
    </main>
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
  const colorMap: Record<UploadState, string> = {
    idle: "bg-slate-100 text-slate-600",
    uploading: "bg-amber-100 text-amber-700",
    processing: "bg-cyan-100 text-cyan-700",
    completed: "bg-emerald-100 text-emerald-700",
    failed: "bg-rose-100 text-rose-700"
  };

  return <span className={`rounded-md px-2.5 py-1 text-xs font-medium ${colorMap[state]}`}>{labelMap[state]}</span>;
}

function TranscriptBubble({ item, color }: { item: TranscriptItem; color: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-2 font-medium text-slate-700">
          <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
          {item.speaker}
        </span>
        <time className="tabular-nums text-slate-500">{formatTime(item.start_time)}</time>
      </div>
      <p className="text-sm leading-6 text-slate-800">{item.text}</p>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-slate-900 text-white">
          <Bot size={15} />
        </div>
      )}
      <div className={`max-w-[78%] rounded-md px-3 py-2 text-sm leading-6 ${isUser ? "bg-cyan-600 text-white" : "bg-slate-100 text-slate-800"}`}>
        {message.content}
      </div>
      {isUser && (
        <div className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-cyan-600 text-white">
          <UserRound size={15} />
        </div>
      )}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="grid h-full min-h-40 place-items-center rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}

async function fetchMeetingStatus(meetingId: string): Promise<MeetingStatus> {
  const response = await fetch(`${API_BASE_URL}/api/meetings/${meetingId}/status`);
  if (!response.ok) {
    const detail = await readError(response);
    throw new Error(detail);
  }
  return response.json();
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

export default App;
