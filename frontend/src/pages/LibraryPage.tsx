import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BrainCircuit, Home, Search, Trash2, Upload } from "lucide-react";
import {
  fetchMeetings,
  fetchStats,
  mutateMeeting,
  refreshProcessingMeetings,
  uploadMeeting
} from "../api/meetings";
import { MeetingRow } from "../components/MeetingRow";
import { UploadDropzone } from "../components/UploadDropzone";
import type { LibraryViewMode, MeetingListItem, MeetingStats, UploadState } from "../types/meeting";

const defaultStats: MeetingStats = {
  used_minutes: 0,
  meeting_count: 0,
  processing_count: 0,
  trash_count: 0
};

export function LibraryPage() {
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
      const nextMeetings = await fetchMeetings(mode === "trash");
      const refreshedMeetings = await refreshProcessingMeetings(nextMeetings);
      const nextStats = await fetchStats();
      setMeetings(refreshedMeetings);
      setStats(nextStats);
    } catch (error) {
      console.error(error);
    }
  };

  const handleFileUpload = async (file: File) => {
    setUploadState("uploading");
    setStatusText("文件上传中...");
    setUploadProgress(18);

    try {
      const data = await uploadMeeting(file);
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
      setUploadProgress(0);
      setStatusText(error instanceof Error ? `上传失败：${error.message}` : "上传失败");
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
