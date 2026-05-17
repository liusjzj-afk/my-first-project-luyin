import { useEffect, useState } from "react";
import { API_BASE_URL, fetchMeetingStatus } from "../api/meetings";
import type { MeetingStatus } from "../types/meeting";

export function useMeetingStatus(meetingId: string) {
  const [meeting, setMeeting] = useState<MeetingStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!meetingId) return undefined;
    let isCancelled = false;
    let fallbackTimer: number | undefined;

    const load = async () => {
      try {
        const next = await fetchMeetingStatus(meetingId);
        if (!isCancelled) {
          setMeeting(next);
          setError("");
        }
      } catch (loadError) {
        if (!isCancelled) setError(loadError instanceof Error ? loadError.message : "读取会议状态失败");
      }
    };

    void load();

    const events = new EventSource(`${API_BASE_URL}/api/meetings/${meetingId}/stream-events`);
    events.addEventListener("meeting_status", () => {
      void load();
    });
    events.onerror = () => {
      fallbackTimer = window.setInterval(() => void load(), 5000);
      events.close();
    };

    return () => {
      isCancelled = true;
      events.close();
      if (fallbackTimer) window.clearInterval(fallbackTimer);
    };
  }, [meetingId]);

  return { meeting, error, setMeeting };
}
