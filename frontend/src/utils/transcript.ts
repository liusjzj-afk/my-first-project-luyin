import type { TranscriptItem, TranscriptSegment } from "../types/meeting";

export function normalizeTranscriptSegments(transcript: TranscriptItem[], durationSeconds: number): TranscriptSegment[] {
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

export function findActiveTranscriptIndex(
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
