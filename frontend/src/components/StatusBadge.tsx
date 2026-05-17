import type { TaskStatus } from "../types/meeting";

export function StatusBadge({ status }: { status: TaskStatus }) {
  const labelMap: Record<TaskStatus, string> = {
    PENDING: "文件上传中",
    PROCESSING: "语音识别中",
    SUMMARIZING: "AI 提取中",
    COMPLETED: "已完成",
    FAILED: "失败"
  };
  return <span className={`detail-status ${status.toLowerCase()}`}>{labelMap[status]}</span>;
}
