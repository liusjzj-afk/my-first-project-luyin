# SystemReq-Copilot 项目交接记录

更新时间：2026-05-16

## 1. 当前项目定位

SystemReq-Copilot 是一个会议音视频智能需求分析工具。当前已具备：

- 上传会议音频/视频。
- 阿里云 OSS 上传与智能语音交互 ASR 异步识别。
- SQLite 保存会议、逐字稿、纪要和聊天记录。
- LLM 根据逐字稿生成需求文档与信息架构。
- 前端列表页、详情页、Tabs 文档阅读、AI Agent 问答。

工作目录：

```bash
/Users/shunju/Documents/录音 转文字
```

## 2. 当前运行方式

后端：

```bash
cd "/Users/shunju/Documents/录音 转文字"
source .venv/bin/activate
uvicorn main:app --reload --port 8000
```

前端开发服务：

```bash
cd "/Users/shunju/Documents/录音 转文字/frontend"
npm run dev -- --host 127.0.0.1
```

当前前端曾通过 `launchctl` 启动在：

```bash
http://127.0.0.1:5173/
```

如果页面打不开，优先检查：

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
curl -I http://127.0.0.1:5173/
```

若 5173 不在，重新启动前端开发服务即可。

后端健康检查：

```bash
curl http://127.0.0.1:8000/api/health
```

预期：

```json
{"status":"ok"}
```

## 3. 当前配置状态

配置文件：

```bash
.env
```

关键配置：

```env
LLM_BASE_URL=https://api.minimaxi.com/v1
LLM_MODEL=MiniMax-M2.5

ALIYUN_REGION_ID=cn-guangzhou
ALIYUN_ASR_REGION_ID=cn-shanghai
ALIYUN_OSS_ENDPOINT=oss-cn-guangzhou.aliyuncs.com
ALIYUN_OSS_BUCKET=systemreq-copilot-shunju-202605
```

注意：

- OSS Bucket 是广州。
- ASR endpoint 是上海：`filetrans.cn-shanghai.aliyuncs.com`。
- 不要把 ASR endpoint 改成广州，否则会 DNS 失败。
- LLM 使用 MiniMax OpenAI-compatible API，若返回 `429 insufficient_quota`，通常是账号额度/计费问题。

## 4. 后端当前核心状态

关键文件：

```bash
main.py
models.py
schemas.py
api/meetings.py
services/asr_service.py
services/llm_service.py
config.py
```

### 4.1 数据模型

文件：

```bash
models.py
```

核心表：

- `Meeting`
- `ChatHistory`

`Meeting` 当前关键字段：

```python
id
title
audio_file_path
upload_time
asr_task_id
asr_status
duration_seconds
audio_duration
deleted_at
transcript_json
summary_markdown
summary_content
ia_content
```

`ASRStatus` 当前枚举：

```python
PENDING
PROCESSING
SUMMARIZING
COMPLETED
FAILED
```

`ensure_schema()` 当前会为 SQLite 追加兼容字段：

```python
duration_seconds
audio_duration
deleted_at
summary_content
ia_content
```

本地数据库已执行过 schema 补齐。

### 4.2 上传与 ASR

文件：

```bash
api/meetings.py
services/asr_service.py
```

上传接口：

```http
POST /api/meetings/upload
```

支持格式：

```text
.mp3 .wav .m4a .mp4 .aac .opus
```

上传流程：

1. 保存文件到 `uploads/`。
2. 使用 `mutagen` 读取真实音频时长，写入 `audio_duration` 与 `duration_seconds`。
3. 上传到阿里云 OSS。
4. 生成 OSS 签名 URL。
5. 调用阿里云 `SubmitTask`。
6. 创建 `Meeting`，状态为 `PROCESSING`。

### 4.3 状态、ETA 与进度

接口：

```http
GET /api/meetings
GET /api/meetings/stats
GET /api/meetings/{meeting_id}/status
```

列表和状态接口返回：

```python
audio_duration
eta_seconds
progress_percent
summary_content
ia_content
```

ETA 逻辑：

```python
ETA = audio_duration * 0.3 - 已等待时间
```

约束：

- 只在 `PROCESSING` 状态返回 ETA。
- 不返回负数。
- 最小值为 1 秒。

进度逻辑：

- `PENDING`: 5
- `PROCESSING`: 基于等待时间和估算总时长，最高 90
- `SUMMARIZING`: 92
- `COMPLETED`: 100
- `FAILED`: 100

### 4.4 LLM Prompt 与分段解析

文件：

```bash
services/llm_service.py
```

当前 `SUMMARY_SYSTEM_PROMPT` 已替换为 BA 方法论版本，要求输出：

```text
<!-- SUMMARY_START -->
...需求全景概览 / SCQA / 用户故事 / Unhappy Path / SMART...
<!-- SUMMARY_END -->
<!-- IA_START -->
...系统信息架构图，节点标注 P0/P1/P2...
<!-- IA_END -->
```

关键函数：

```python
format_transcript_for_llm()
strip_model_thinking()
split_summary_sections()
_extract_between_markers()
```

逐字稿发送格式：

```text
[00:15-00:30] speaker: text
```

LLM 返回后：

- `strip_model_thinking()` 移除 `<think>...</think>`。
- `split_summary_sections()` 按 `SUMMARY` 和 `IA` 标记拆分。
- `summary_content` 保存需求分析部分。
- `ia_content` 保存信息架构部分。
- `summary_markdown` 保存原始完整 Markdown。

注意：旧会议是在新 Prompt 前生成的，通常没有 `ia_content`，前端会显示“暂无信息架构”。新上传完成后会按新逻辑写入。

### 4.5 AI 对话

接口：

```http
POST /api/meetings/{meeting_id}/chat
```

逻辑：

- 只允许 `COMPLETED` 且有逐字稿的会议提问。
- 使用当前会议逐字稿和 `summary_content` 作为上下文。
- 读取最近 10 条 `ChatHistory`。
- 返回后写入用户与助手消息。

## 5. 前端当前核心状态

关键文件：

```bash
frontend/src/App.tsx
frontend/src/styles.css
frontend/tailwind.config.js
frontend/package.json
frontend/package-lock.json
```

新增依赖：

```json
{
  "@tailwindcss/typography": "^0.5.15",
  "react-router-dom": "^6.28.0",
  "remark-gfm": "^4.0.0"
}
```

仍保留：

```json
{
  "react-markdown": "^9.0.1",
  "lucide-react": "^0.468.0",
  "react-resizable-panels": "^2.1.7"
}
```

`tailwind.config.js` 当前启用：

```js
import typography from "@tailwindcss/typography";

plugins: [typography]
```

### 5.1 路由结构

文件：

```bash
frontend/src/App.tsx
```

当前使用 React Router：

```tsx
<BrowserRouter>
  <Routes>
    <Route path="/" element={<LibraryPage />} />
    <Route path="/meeting/:meetingId" element={<DetailPage />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
</BrowserRouter>
```

### 5.2 列表页交互

组件：

```tsx
LibraryPage
UploadDropzone
MeetingRow
TaskStatusCell
```

当前行为：

- 上传音频/视频后，不自动跳转详情页。
- 上传后在列表中插入一条临时处理中记录。
- 列表每 5 秒刷新处理中任务。
- 用户点击「查看详情」才进入 `/meeting/{id}`。
- 支持「我的内容」与「回收站」。

状态列：

- `PENDING`: 文件上传中...
- `PROCESSING`: 进度条 + ETA 文案
- `SUMMARIZING`: AI 需求提取中...
- `COMPLETED`: Lucide `CheckCircle2` + 已完成
- `FAILED`: 识别失败

### 5.3 详情页结构

组件：

```tsx
DetailPage
TabButton
MarkdownDocument
TranscriptDocument
AgentSidebar
ChatBubble
AiThinkingBubble
StatusBadge
```

当前结构：

- 左侧文档区 70%。
- 右侧 AI Agent 30%。
- 左侧 Tabs：
  - 系统需求分析纪要
  - 信息架构与优先级
  - 会议文字记录
- AI Agent 固定在右侧，支持上下文提问。
- 发送问题后显示 `AI 正在结合会议纪要检索中...` loading 气泡。

Markdown 渲染：

```tsx
<ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
```

容器 class：

```tsx
className="markdown-card prose prose-slate max-w-none"
```

### 5.4 当前视觉风格

最近一次已按 `ui-ux-pro-max` 调整为苹果极简风格：

- 浅色背景：`#f5f5f7` / `#fbfbfd`
- 系统字体：`-apple-system`, `BlinkMacSystemFont`, `SF Pro Display`, `SF Pro Text`
- Apple 蓝：`#007aff`
- 半透明白色毛玻璃卡片
- 轻边框、柔和阴影、大圆角
- 主按钮和图标按钮触控尺寸 ≥ 44px
- focus ring 清晰
- pressed feedback 使用轻微 scale
- 支持 `prefers-reduced-motion`
- 去掉结构性 emoji，改用 Lucide 图标

主要样式变量在：

```css
:root {
  --bg: #f5f5f7;
  --surface: rgba(255, 255, 255, 0.86);
  --text: #1d1d1f;
  --muted: #6e6e73;
  --accent: #007aff;
}
```

## 6. 当前验证记录

已通过：

```bash
.venv/bin/python -m py_compile config.py models.py schemas.py main.py api/meetings.py services/asr_service.py services/llm_service.py scripts/integration_check.py
```

已通过：

```bash
cd frontend
npm run build
```

最近构建产物示例：

```text
dist/assets/index-DL1Eshsg.css
dist/assets/index-BtyZ0x3Q.js
```

后端健康检查正常：

```bash
curl http://127.0.0.1:8000/api/health
```

前端开发服务曾确认：

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
curl -I http://127.0.0.1:5173/
```

## 7. 当前数据情况

接口当前能看到至少一条完成会议：

```http
GET /api/meetings
```

示例 ID：

```text
235f2a97-bc9d-49d5-955b-91d06427f756
```

详情路由：

```text
http://127.0.0.1:5173/meeting/235f2a97-bc9d-49d5-955b-91d06427f756
```

注意：旧会议可能没有 `ia_content`，因为它是在新 Prompt 前生成的。

## 8. 当前 Git 状态

当前有未提交改动：

```bash
api/meetings.py
frontend/package-lock.json
frontend/package.json
frontend/src/App.tsx
frontend/src/styles.css
frontend/tailwind.config.js
models.py
requirements.txt
schemas.py
scripts/integration_check.py
services/llm_service.py
PROJECT_HANDOFF.md
```

这些改动尚未提交。

## 9. 重要注意事项

1. 前端页面打不开时，通常是 5173 服务没启动，不一定是代码问题。
2. Vite 进程用普通后台方式可能被当前工具会话清理；必要时直接在终端手动运行 `npm run dev -- --host 127.0.0.1`。
3. 如果用了 `launchctl submit` 启动前端，可用以下命令清理：

```bash
launchctl remove systemreq-copilot-frontend
```

4. 旧会议的 `summary_content` 可能来自旧 Prompt，`ia_content` 为空是正常现象。
5. 需要重新上传真实会议音频后，才能完整验证新 Prompt 的 `SUMMARY/IA` 拆分链路。
6. `ui-ux-pro-max` 技能脚本路径 `/Users/shunju/.codex/skills/ui-ux-pro-max/SKILL.md` 是文件，不是目录；本轮是根据用户贴出的技能内容和规则执行的。

## 10. 建议下一步

优先级建议：

1. 启动前后端，打开列表页和详情页，人工确认苹果极简 UI 是否符合预期。
2. 用一条新的真实会议音频跑端到端：
   - 上传后停留列表页。
   - 列表展示处理中进度。
   - 点击查看详情进入 `/meeting/{id}`。
   - ASR 完成后 LLM 写入 `summary_content` 和 `ia_content`。
   - Tabs 分别展示需求纪要、信息架构、逐字稿。
   - AI Agent 可提问。
3. 如果新 UI 认可，提交当前改动。
4. 如果希望继续优化 UI，建议重点处理：
   - 移动端布局细节。
   - 空状态和错误状态。
   - 删除/恢复操作的确认与 toast。
   - 新旧会议的手动“重新生成纪要”接口。
