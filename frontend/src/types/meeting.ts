export type TaskStatus = "PENDING" | "PROCESSING" | "SUMMARIZING" | "COMPLETED" | "FAILED";
export type LibraryViewMode = "list" | "trash";
export type DetailTab = "summary" | "ia" | "transcript";
export type UploadState = "idle" | "uploading" | "processing" | "summarizing" | "completed" | "failed";

export type TranscriptItem = {
  speaker: string;
  start_time?: number;
  end_time?: number;
  startTime?: number;
  endTime?: number;
  text: string;
};

export type TranscriptSegment = {
  speaker: string;
  startTime: number;
  endTime: number;
  text: string;
};

export type MeetingStatus = {
  meeting_id: string;
  status: TaskStatus;
  asr_status?: string | null;
  llm_status?: string | null;
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

export type MeetingListItem = {
  id: string;
  title: string;
  upload_time: string;
  asr_status: TaskStatus;
  llm_status?: string | null;
  duration_seconds: number;
  audio_duration: number;
  eta_seconds?: number | null;
  progress_percent?: number | null;
  deleted_at?: string | null;
};

export type MeetingStats = {
  used_minutes: number;
  meeting_count: number;
  processing_count: number;
  trash_count: number;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};
