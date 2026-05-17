import type { RefObject } from "react";
import { FileAudio } from "lucide-react";
import type { UploadState } from "../types/meeting";

type UploadDropzoneProps = {
  inputRef: RefObject<HTMLInputElement>;
  isDragging: boolean;
  uploadState: UploadState;
  statusText: string;
  uploadProgress: number;
  onSetDragging: (value: boolean) => void;
  onUpload: (file: File) => void;
};

export function UploadDropzone({
  inputRef,
  isDragging,
  uploadState,
  statusText,
  uploadProgress,
  onSetDragging,
  onUpload
}: UploadDropzoneProps) {
  return (
    <div
      className={`premium-upload ${isDragging ? "dragging" : ""} ${uploadState === "failed" ? "failed" : ""}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(event) => {
        event.preventDefault();
        onSetDragging(true);
      }}
      onDragLeave={() => onSetDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        onSetDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) onUpload(file);
      }}
    >
      <input
        ref={inputRef}
        className="hidden"
        type="file"
        accept=".mp3,.wav,.m4a,.mp4,.aac,.opus,audio/*,video/*"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onUpload(file);
        }}
      />
      <div className="upload-icon">
        <FileAudio size={22} />
      </div>
      <div>
        <strong>{statusText}</strong>
        <span>支持音频/视频文件。上传后不会自动跳转，可从列表手动查看详情。</span>
      </div>
      {uploadState !== "idle" && (
        <div className="upload-progress">
          <div style={{ width: `${uploadProgress}%` }} />
        </div>
      )}
    </div>
  );
}
