# 商业化架构重构交接记录

更新时间：2026-05-17，Asia/Shanghai

## 当前结论

商业化重构的主干架构已经落地，但还不是生产商业化上线完成态。

当前已完成：去除 `GET /status` 副作用、后台任务边界、Celery/Redis 入口、双状态机、租户过滤、UsageLog/Transcript/Summary 数据底座、Alembic 骨架、OSS 直传/签名播放接口、旧 Web 节点大文件 IO 默认禁用、SSE 状态推送接口、前端 SSE hook、前端大文件拆分、基础测试。

本轮继续完成：旧后端上传/本地媒体流已改为显式开关且默认禁用；租户上下文已从 repository 抽到统一认证依赖；生产可关闭启动时自动补 schema，数据库交给 Alembic；当前本地 SQLite 已执行 `alembic upgrade head` 并验证表结构；OSS 签名与 LLM 连通性已通过轻量检查。

仍需完成：真实 Redis/Celery worker 环境端到端联调、真实登录/JWT/RBAC、计费聚合、生产数据库迁移演练、完整生产部署配置。

## 已完成的核心改造

### 1. GET status 已改为只读

文件：

```text
api/meetings.py
services/meeting_processing.py
```

当前 `GET /api/meetings/{id}/status` 只读取数据库并返回状态，不再调用阿里云 ASR，不再触发 LLM。

状态推进被移到：

```text
services/meeting_processing.py
tasks/meetings.py
```

本地开发默认使用后台线程；生产可设置 `ENABLE_CELERY=true` 切到 Celery worker。

### 2. 双状态机

文件：

```text
models.py
services/meeting_processing.py
schemas.py
```

新增：

```python
class LLMStatus(str, enum.Enum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
```

`Meeting` 现在包含：

```python
asr_status
llm_status
llm_error
```

为了兼容现有前端，后端仍返回 legacy 单字段：

```python
status = overall_status(meeting)
```

同时返回：

```python
asr_status
llm_status
```

### 3. 单独重试 LLM 总结

文件：

```text
api/meetings.py
services/meeting_processing.py
frontend/src/api/meetings.ts
frontend/src/pages/DetailPage.tsx
```

接口：

```http
POST /api/meetings/{meeting_id}/retry-summary
```

语义：

- 仅当 `asr_status=COMPLETED` 且已有 `transcript_json` 时允许。
- 不重跑 ASR。
- 将 `llm_status` 重置为 `PENDING`。
- 清空旧 summary 字段。
- 重新入队 LLM 总结任务。

前端在 `asr_status=COMPLETED && llm_status=FAILED` 时显示“重新生成需求纪要”按钮。

### 4. 多租户隔离底座

文件：

```text
repositories/meetings.py
api/meetings.py
models.py
config.py
auth.py
```

当前租户上下文来自统一依赖：

```text
auth.py
```

开发模式仍可从 header 读取：

```http
X-Tenant-Id
X-User-Id
```

未传时使用 `.env` 默认值：

```env
DEFAULT_TENANT_ID=public
DEFAULT_USER_ID=local-user
```

Repository 层强制过滤：

```python
get_meeting_for_context(db, meeting_id, context)
query_meetings_for_context(db, context)
```

配置：

```env
AUTH_MODE=development
```

生产若由网关或认证代理注入可信身份，可设置：

```env
AUTH_MODE=trusted_headers
```

此时缺少 `X-Tenant-Id` 或 `X-User-Id` 会直接返回 401。

注意：这仍不是完整登录态、JWT、Session 或 RBAC，只是把身份解析集中到一个入口，便于后续替换为真实鉴权。

### 5. 用量记录与计费底座

文件：

```text
models.py
services/meeting_processing.py
services/llm_service.py
```

新增表模型：

```python
UsageLog
Transcript
Summary
```

ASR 完成后记录：

```python
service=UsageService.ASR
provider="aliyun"
quantity_seconds=meeting.duration_seconds
request_id=meeting.asr_task_id
```

LLM 总结完成后记录：

```python
service=UsageService.LLM
provider="openai-compatible"
model=llm_service.model
input_tokens
output_tokens
total_tokens
```

注意：UsageLog 只是原始用量事件，还没有价格表、账单聚合、套餐额度、超额计费。

### 6. Alembic 迁移骨架

文件：

```text
alembic.ini
alembic/env.py
alembic/versions/20260517_commercial_foundation.py
```

迁移包含：

- `meetings.tenant_id`
- `meetings.user_id`
- `meetings.meeting_type`
- `meetings.llm_status`
- `meetings.llm_error`
- `meetings.media_object_key`
- `meetings.media_bucket`
- `meetings.media_size_bytes`
- `meetings.media_content_type`
- `chat_histories.tenant_id`
- `chat_histories.user_id`
- 新表 `transcripts`
- 新表 `summaries`
- 新表 `usage_logs`

注意：`models.ensure_schema()` 仍保留，用于本地 SQLite 兼容启动。商业化生产应改用 Alembic 管理迁移。

### 7. OSS 直传与签名播放

文件：

```text
api/uploads.py
services/object_storage.py
frontend/src/api/meetings.ts
```

新增接口：

```http
GET /api/upload/presigned-url?filename=xxx.m4a&content_type=audio/mp4
POST /api/upload/complete
```

流程：

1. 前端请求预签名 URL。
2. 前端 `PUT` 文件到 OSS。
3. 前端调用 `/api/upload/complete`。
4. 后端用 OSS object key 生成签名 GET URL，提交 ASR。
5. 后端保存 `media_object_key` 等元数据。
6. 后台处理 ASR/LLM。

前端当前逻辑：

```text
优先直传 OSS
只有 VITE_ENABLE_LEGACY_UPLOAD_FALLBACK=true 时才 fallback 到旧 POST /api/meetings/upload
```

后端旧路径当前由显式开关控制，默认禁用：

```env
ALLOW_LEGACY_UPLOAD=false
ALLOW_LOCAL_AUDIO_STREAM=false
```

旧接口保留代码路径是为了必要时本地兼容，但商业化默认不会启用 Web 节点大文件 IO。

### 8. Celery + Redis 任务边界

文件：

```text
celery_app.py
tasks/meetings.py
services/meeting_processing.py
requirements.txt
.env.example
```

新增依赖：

```text
celery==5.4.0
redis==5.0.7
```

配置：

```env
ENABLE_CELERY=false
CELERY_BROKER_URL=redis://localhost:6379/0
CELERY_RESULT_BACKEND=redis://localhost:6379/1
```

生产 Worker 启动：

```bash
.venv/bin/celery -A celery_app.celery_app worker --loglevel=INFO
```

注意：当前机器未安装/运行 Redis，`redis://localhost:6379/0` 探测结果为 connection refused，因此仍未完成真实 Redis/Celery worker 端到端验证。

### 9. SSE 状态推送

文件：

```text
api/meetings.py
services/events.py
frontend/src/hooks/useMeetingStatus.ts
frontend/src/pages/DetailPage.tsx
```

接口：

```http
GET /api/meetings/{meeting_id}/stream-events
```

事件发布：

```python
publish_meeting_event(meeting.id, "meeting_status", {...})
```

事件订阅：

```python
subscribe_meeting_events(meeting_id)
```

当前实现：

- `ENABLE_CELERY=true` 时优先使用 Redis Pub/Sub。
- 否则使用本地内存事件总线。
- 前端 EventSource 失败后会 fallback 到 5 秒轮询。

### 10. 前端拆分

原 `frontend/src/App.tsx` 已从 1000+ 行缩成路由入口。

新增结构：

```text
frontend/src/api/meetings.ts
frontend/src/types/meeting.ts
frontend/src/hooks/useMeetingStatus.ts
frontend/src/pages/LibraryPage.tsx
frontend/src/pages/DetailPage.tsx
frontend/src/components/AgentSidebar.tsx
frontend/src/components/MarkdownDocument.tsx
frontend/src/components/MeetingRow.tsx
frontend/src/components/StatusBadge.tsx
frontend/src/components/TabButton.tsx
frontend/src/components/TranscriptPlayerDocument.tsx
frontend/src/components/UploadDropzone.tsx
frontend/src/utils/markdown.ts
frontend/src/utils/mermaid.ts
frontend/src/utils/time.ts
frontend/src/utils/transcript.ts
```

### 11. Prompt 管理

文件：

```text
services/llm_service.py
prompts/README.md
config.py
models.py
```

新增：

```python
Meeting.meeting_type
load_summary_prompt(meeting_type)
```

加载规则：

```text
./prompts/{meeting_type}.md
```

未找到时 fallback 到内置 BA 总结 Prompt。

## 当前验证结果

已执行并通过：

```bash
.venv/bin/python -m pytest tests -q
```

结果：

```text
17 passed
```

已执行并通过：

```bash
.venv/bin/python -m py_compile main.py config.py models.py schemas.py auth.py api/meetings.py api/uploads.py services/asr_service.py services/llm_service.py services/meeting_processing.py services/object_storage.py services/events.py celery_app.py tasks/meetings.py repositories/meetings.py media/audio.py alembic/env.py alembic/versions/20260517_commercial_foundation.py
```

已执行并通过：

```bash
cd frontend
npm run build
```

说明：

- 前端构建通过。
- 仍有 Mermaid 相关 chunk size warning，是既有依赖体积问题。

已执行并通过：

```bash
.venv/bin/alembic upgrade head
```

本地 SQLite 验证结果：

```text
alembic_version=20260517_commercial_foundation
tables=alembic_version,chat_histories,meetings,summaries,transcripts,usage_logs
```

已执行并通过轻量外部检查：

```text
OSS_SIGN_OK
LLM_OK
```

Redis 探测结果：

```text
ConnectionError: Error 61 connecting to localhost:6379. Connection refused.
```

## 当前测试覆盖

```text
tests/test_meeting_processing.py
tests/test_meetings_status.py
tests/test_media_audio.py
```

覆盖点：

- ASR 状态映射。
- ASR/转写时长提取。
- LLM 失败总结兜底文案。
- `GET /status` 不实例化 ASR/LLM，不写库。
- 租户隔离：跨租户读会议返回 404。
- `retry-summary` 只重置 LLM 状态，不重跑 ASR。
- 旧后端上传默认返回 410。
- 本地音频流默认返回 410。
- `AUTH_MODE=trusted_headers` 缺身份时返回 401。
- Range 解析。
- 中文文件名 Content-Disposition。

## 仍未完成的工作

### P0：生产环境联调

1. 启动 Redis。
2. 设置：

```env
ENABLE_CELERY=true
```

3. 启动 Web：

```bash
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
```

4. 启动 Worker：

```bash
.venv/bin/celery -A celery_app.celery_app worker --loglevel=INFO
```

5. 验证：

- OSS 直传。
- `/api/upload/complete` 提交 ASR。
- Worker 轮询 ASR。
- Worker 生成 LLM summary。
- UsageLog 写入。
- SSE 经 Redis Pub/Sub 推送到前端。

当前状态：OSS 签名和 LLM 轻量检查通过；Redis/Celery 因本机无 Redis 服务未完成。

### P0：执行或验证 Alembic 迁移

开发库可继续用 `ensure_schema()`，但生产建议设置：

```env
AUTO_ENSURE_SCHEMA=false
```

并使用：

```bash
.venv/bin/alembic upgrade head
```

当前已在本地 SQLite 执行成功；仍需要在生产同类型数据库上演练。

### P0：真实认证鉴权

当前 `auth.py` 支持 `development` 和 `trusted_headers`，但真实用户认证仍未接入。

商业化上线前必须接入：

- 登录态或 JWT。
- 租户 membership 校验。
- 用户权限。
- 管理员/普通成员角色。

### P0：彻底废除旧 Web 节点大文件 IO

当前仍保留：

```http
POST /api/meetings/upload
GET /api/meetings/{id}/audio
```

旧路径用于必要时本地兼容，但默认禁用。

商业化上线前若要彻底删除代码，应：

- 删除后端直接上传。
- 删除后端本地 Range 流。
- 全面使用 OSS/CDN 直传和签名播放。

### P1：计费系统

UsageLog 已有，但还缺：

- 价格表。
- 计费聚合任务。
- 租户月账单。
- 套餐额度。
- 超额限制。
- 用量查询 API。

### P1：Prompt 版本控制

当前支持 `meeting_type` 文件模板，但还缺：

- Prompt 版本号。
- 历史 summary 使用哪个 Prompt 的记录。
- 后台管理 UI。
- Prompt 变更审计。

### P1：前端进一步产品化

当前前端已拆分并接入 SSE，但还可继续：

- Library 页也改为 SSE 或轻量事件刷新。
- 上传流程显示 OSS 直传阶段、ASR 阶段、LLM 阶段。
- LLM 失败状态更明确。
- retry-summary 按钮样式和位置产品化。

## 新对话建议从这里开始

建议下一轮优先做：

1. 安装/启动真实 Redis，完成 Celery worker + SSE Redis Pub/Sub 端到端联调。
2. 修复联调发现的问题。
3. 在生产同类型数据库上跑 Alembic 迁移演练。
4. 接入真实登录/JWT/RBAC，替换 `auth.py` 当前可信 header 模式。
5. 开始计费聚合：价格表、月账单、套餐额度和用量查询 API。

可以直接引用这份文件：

```text
COMMERCIAL_REFACTOR_HANDOFF.md
```
