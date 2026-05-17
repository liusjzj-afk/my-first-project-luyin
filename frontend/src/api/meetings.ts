import type { MeetingListItem, MeetingStats, MeetingStatus } from "../types/meeting";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";
const ENABLE_LEGACY_UPLOAD_FALLBACK = import.meta.env.VITE_ENABLE_LEGACY_UPLOAD_FALLBACK === "true";

export async function uploadMeeting(file: File): Promise<{ meeting_id: string }> {
  try {
    return await directUploadMeeting(file);
  } catch (error) {
    if (!ENABLE_LEGACY_UPLOAD_FALLBACK) throw error;
    console.warn("Direct upload failed, falling back to backend upload", error);
  }

  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${API_BASE_URL}/api/meetings/upload`, {
    method: "POST",
    body: formData
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function directUploadMeeting(file: File): Promise<{ meeting_id: string }> {
  const presignParams = new URLSearchParams({
    filename: file.name,
    content_type: file.type || "application/octet-stream"
  });
  const presignResponse = await fetch(`${API_BASE_URL}/api/upload/presigned-url?${presignParams.toString()}`);
  if (!presignResponse.ok) throw new Error(await readError(presignResponse));
  const presign = (await presignResponse.json()) as {
    meeting_id: string;
    object_key: string;
    upload_url: string;
    headers?: Record<string, string>;
  };

  const uploadResponse = await fetch(presign.upload_url, {
    method: "PUT",
    headers: presign.headers || {},
    body: file
  });
  if (!uploadResponse.ok) throw new Error("直传云存储失败");

  const completeResponse = await fetch(`${API_BASE_URL}/api/upload/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      object_key: presign.object_key,
      title: file.name,
      size_bytes: file.size,
      content_type: file.type || "application/octet-stream"
    })
  });
  if (!completeResponse.ok) throw new Error(await readError(completeResponse));
  return completeResponse.json();
}

export async function sendMeetingChat(meetingId: string, message: string): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/api/meetings/${meetingId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });
  if (!response.ok) throw new Error(await readError(response));
  const data = (await response.json()) as { reply: string };
  return data.reply;
}

export async function retryMeetingSummary(meetingId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/meetings/${meetingId}/retry-summary`, {
    method: "POST"
  });
  if (!response.ok) throw new Error(await readError(response));
}

export async function fetchMeetings(trash = false): Promise<MeetingListItem[]> {
  const response = await fetch(`${API_BASE_URL}/api/meetings?trash=${trash}`);
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function fetchStats(): Promise<MeetingStats> {
  const response = await fetch(`${API_BASE_URL}/api/meetings/stats`);
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function fetchMeetingStatus(meetingId: string): Promise<MeetingStatus> {
  const response = await fetch(`${API_BASE_URL}/api/meetings/${meetingId}/status`);
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function refreshProcessingMeetings(meetings: MeetingListItem[]): Promise<MeetingListItem[]> {
  const processingMeetings = meetings.filter(
    (item) => item.asr_status === "PROCESSING" || item.asr_status === "SUMMARIZING"
  );

  if (!processingMeetings.length) return meetings;

  const statuses = await Promise.all(
    processingMeetings.map(async (item) => {
      try {
        return await fetchMeetingStatus(item.id);
      } catch (error) {
        console.error(error);
        return null;
      }
    })
  );
  const statusById = new Map(statuses.filter((item): item is MeetingStatus => Boolean(item)).map((item) => [item.meeting_id, item]));

  return meetings.map((item) => {
    const status = statusById.get(item.id);
    if (!status) return item;
    return {
      ...item,
      asr_status: status.status,
      duration_seconds: status.duration_seconds ?? item.duration_seconds,
      audio_duration: status.audio_duration ?? item.audio_duration,
      eta_seconds: status.eta_seconds,
      progress_percent: status.progress_percent
    };
  });
}

export async function mutateMeeting(path: string, method: "DELETE" | "POST") {
  const response = await fetch(`${API_BASE_URL}${path}`, { method });
  if (!response.ok) throw new Error(await readError(response));
}

export function resolveApiUrl(pathOrUrl: string) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${API_BASE_URL}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

async function readError(response: Response) {
  try {
    const body = await response.json();
    return body.detail || "请求失败";
  } catch {
    return "请求失败";
  }
}
