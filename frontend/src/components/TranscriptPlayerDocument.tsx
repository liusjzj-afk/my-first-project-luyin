import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskStatus, TranscriptItem, TranscriptSegment } from "../types/meeting";
import { findActiveTranscriptIndex, normalizeTranscriptSegments } from "../utils/transcript";
import { formatSeconds } from "../utils/time";

type TranscriptPlayerDocumentProps = {
  transcript: TranscriptItem[];
  status?: TaskStatus;
  audioUrl: string;
  durationSeconds: number;
};

export function TranscriptPlayerDocument({
  transcript,
  status,
  audioUrl,
  durationSeconds
}: TranscriptPlayerDocumentProps) {
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
