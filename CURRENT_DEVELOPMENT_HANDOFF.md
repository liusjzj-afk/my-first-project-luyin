# 当前开发交接：会议文字记录点击跳播

更新时间：2026-05-17，Asia/Shanghai

## 当前目标

会议详情页的「会议文字记录」需要支持：

1. 点击任意一段文字卡片。
2. 顶部录音播放器跳转到该段对应开始时间。
3. 播放器立即播放。
4. 当前段落高亮。

同时保证原有上传功能仍可用。

## 当前运行状态

当前本机观察到：

- 前端 Vite 正在监听：`http://127.0.0.1:5173`
- 后端 FastAPI 正在监听：`http://127.0.0.1:8000`
- 后端健康检查：`curl http://127.0.0.1:8000/api/health` 返回 `{"status":"ok"}`

如果上传失败，第一优先级检查后端是否在跑。前端列表页上传调用的是：

```text
POST http://127.0.0.1:8000/api/meetings/upload
```

后端未运行时，上传会表现为不可用。

启动后端：

```bash
cd "/Users/shunju/Documents/录音 转文字"
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
```

当前曾用以下方式把后端挂到后台，方便本轮测试后继续使用：

```bash
launchctl remove systemreq-copilot-backend >/dev/null 2>&1 || true
launchctl submit -l systemreq-copilot-backend -- /bin/zsh -lc 'cd "/Users/shunju/Documents/录音 转文字" && exec .venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000 > /tmp/systemreq-copilot-backend.log 2>&1'
```

停止这个后台后端：

```bash
launchctl remove systemreq-copilot-backend
```

启动前端：

```bash
cd "/Users/shunju/Documents/录音 转文字/frontend"
npm run dev -- --host 127.0.0.1
```

## 已改动的关键文件

### 1. `frontend/src/App.tsx`

关键组件：

- `TranscriptPlayerDocument`
- `TranscriptDocument`
- `normalizeTranscriptSegments`
- `readTranscriptTimeSeconds`

核心逻辑位置：

- `TranscriptPlayerDocument` 内维护顶部播放器 ref：`audioRef`
- `playSegment(segment)` 负责跳转并播放：
  - 读取 `segment.startTime`
  - 设置 `audio.currentTime`
  - 调用 `audio.play()`
  - 同步 `currentTimeMs`
- `TranscriptDocument` 每段文字卡片是 `<button>`，点击后调用：

```tsx
onClick={() => onSelectSegment(item)}
```

关键代码意图：

```tsx
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
```

时间单位处理很关键。后端标准化字段 `start_time/end_time` 来自阿里云 ASR，单位是毫秒；前端 `startTime/endTime` 兼容历史数据，按音频时长推断秒或毫秒。

```tsx
function readTranscriptTimeSeconds(item: TranscriptItem, boundary: "start" | "end", durationSeconds: number) {
  const snakeValue = boundary === "start" ? item.start_time : item.end_time;
  if (typeof snakeValue === "number") {
    return Math.max(0, snakeValue / 1000);
  }

  const camelValue = boundary === "start" ? item.startTime : item.endTime;
  return normalizeFlexibleTimeValue(camelValue, durationSeconds);
}
```

不要恢复之前的 `parseTimeToSeconds(formatSeconds(...))` 路径。它会把显示文本再反解析，容易出现精度和单位问题。

### 2. `frontend/src/styles.css`

顶部播放器样式：

```css
.audio-player-card {
  position: sticky;
  top: 0;
  z-index: 3;
}
```

目的：逐字稿长列表滚动时，播放器保持在顶部可见。

### 3. `api/meetings.py`

音频接口现在支持 HTTP Range：

```python
@router.get("/{meeting_id}/audio")
def get_meeting_audio(
    meeting_id: str,
    range_header: str | None = Header(default=None, alias="Range"),
    db: Session = Depends(get_db),
) -> Response:
```

为什么需要 Range：

- 浏览器音频播放器 seek 到非开头时间时，经常会发 Range 请求。
- 当前 Starlette 版本的 `FileResponse` 没有自动 Range 支持。
- 不支持 Range 时，长音频跳播容易不稳定。

已修复一个重要回归：中文文件名不能直接放进 `Content-Disposition`，否则 Starlette 会按 latin-1 编码响应头并抛 `UnicodeEncodeError`，导致音频接口 `500`。当前用 ASCII fallback + RFC 5987 `filename*`：

```python
def _content_disposition_header(filename: str) -> str:
    suffix = Path(filename).suffix
    fallback_name = f"meeting-audio{suffix}" if suffix.isascii() else "meeting-audio"
    encoded_name = quote(filename, safe="")
    return f"inline; filename=\"{fallback_name}\"; filename*=UTF-8''{encoded_name}"
```

Range 解析逻辑在：

```python
def _parse_byte_range(range_header: str, file_size: int) -> tuple[int, int]:
```

支持形式：

- `bytes=0-99`
- `bytes=100-`
- `bytes=-64`

## 已验证结果

### 构建和静态检查

通过：

```bash
cd "/Users/shunju/Documents/录音 转文字/frontend"
npm run build
```

通过：

```bash
cd "/Users/shunju/Documents/录音 转文字"
.venv/bin/python -m py_compile api/meetings.py
git diff --check
```

构建有 Vite chunk size warning，属于当前 Mermaid/依赖体积问题，不是本功能回归。

### 上传验证

用 1 秒临时 WAV 文件测试：

- `POST /api/meetings/upload`
- 返回 `200`
- 返回 `meeting_id`
- 测试记录已调用 `/purge` 清理
- 清理后列表恢复为原来的两条会议

结论：上传接口可用。若页面上传不可用，先查 `8000` 后端是否运行。

### 跳播验证

英文文件名会议：

- meeting id: `760c87e1-8d1d-4dae-bfd0-3bd4eba3221a`
- 点击 `01:34-01:42`
- 播放器跳到约 `94.9s`
- `paused=false`
- 当前段落高亮

中文文件名会议：

- meeting id: `5bf92008-b8b0-4881-b585-c573d9fd1c49`
- title: `项目会议角色与讨论重点.m4a`
- 点击 `04:05-04:07`
- 播放器跳到约 `246.5s`
- `paused=false`
- 当前段落高亮
- 音频 Range 返回 `206 Partial Content`
- 不再出现中文响应头导致的 `500`

### Browser 控制台

只看到 React Router v7 future flag warning：

- `v7_startTransition`
- `v7_relativeSplatPath`

未看到本功能相关 error。

## 本轮踩过的坑

1. 只测英文文件名不够。中文文件名会暴露 `Content-Disposition` 响应头编码问题。
2. 后端没跑时，前端上传表现为“上传坏了”。这不是前端上传代码问题，但用户体验上很像功能失效。
3. `FileResponse` 在当前 Starlette 版本不支持 Range，必须自己处理 `Range` 请求。
4. 不要用逐字稿显示时间字符串反解析作为跳播源，应直接使用规范化后的数值时间。

## 建议下一步

1. 给后端音频 Range 和中文文件名响应头补单元测试。
2. 给前端逐字稿点击跳播补 Playwright/e2e 测试，覆盖：
   - 英文文件名
   - 中文文件名
   - 长音频中部段落
   - 上传后列表出现新任务
3. 优化上传失败提示：当 `fetch` 连接失败时，明确提示“后端服务未连接”，不要只显示泛化失败。
4. 考虑把后端/前端启动整理成一个脚本，例如 `scripts/dev.sh`，避免只启动了前端导致上传不可用。

## 新对话建议引用方式

新开对话时，可以直接说：

```text
请读取 /Users/shunju/Documents/录音 转文字/CURRENT_DEVELOPMENT_HANDOFF.md，
继续完成会议文字记录点击跳播和上传可用性相关开发。
```
