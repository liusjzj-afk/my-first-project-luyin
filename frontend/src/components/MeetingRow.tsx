import { CheckCircle2, Mic2, RotateCcw, Trash2, X } from "lucide-react";
import type { MeetingListItem } from "../types/meeting";
import { formatDateTime, formatDuration, formatProcessingText } from "../utils/time";

type MeetingRowProps = {
  meeting: MeetingListItem;
  isTrash: boolean;
  onOpen: (meetingId: string) => void;
  onDelete: (meetingId: string) => void;
  onRestore: (meetingId: string) => void;
  onPurge: (meetingId: string) => void;
};

export function MeetingRow({
  meeting,
  isTrash,
  onOpen,
  onDelete,
  onRestore,
  onPurge
}: MeetingRowProps) {
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
