export function formatTime(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function formatSeconds(value: number) {
  return formatTime(value * 1000);
}

export function formatDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const rest = safeSeconds % 60;
  if (hours) return `${hours} 小时 ${minutes} 分 ${rest} 秒`;
  if (minutes) return `${minutes} 分 ${rest} 秒`;
  return `${rest} 秒`;
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatProcessingText(etaSeconds?: number | null) {
  if (!etaSeconds) return "语音识别中，预计还需计算中";
  const minutes = Math.floor(etaSeconds / 60);
  const seconds = etaSeconds % 60;
  return `语音识别中，预计还需 ${minutes} 分 ${seconds} 秒`;
}
