"""
LLM 需求提取与会议 Agent 对话服务。

使用 openai Python 包，并通过 base_url 支持任何兼容 OpenAI SDK 的模型服务。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import httpx
from openai import OpenAI

from config import get_settings


SUMMARY_SYSTEM_PROMPT = """Role
你是一位精通业务分析方法论（BA）的资深产品经理。你的任务是将口语化、发散的会议转写文本，利用专业的方法论转化为结构化、无遗漏的需求文档。
Task
请阅读【会议记录文本】，并严格按照以下模块进行解析与输出。请直接输出 Markdown 内容，不要包含多余的寒暄。
Output Format (输出规范)
<!-- SUMMARY_START -->
一、 需求全景概览 (基于 5W2H 方法论)
（请提取文本中的全局信息，若缺失请标注“未提及”）
Why (目的)：本次需求的核心业务目标或痛点是什么？
Who (角色)：涉及的核心相关方、用户和系统角色有哪些？
What (做什么)：定下来的核心产品/功能方向是什么？
Where (场景)：将在什么环境、终端下使用？
When (时间)：提及的期望上线时间、排期节点？
How (怎么做)：初步确定的业务流转方式或技术实现方向？
How much (量化)：提及的业务数据量级、频次、预算或期望提升的 ROI 指标？
二、 业务背景还原 (基于 SCQA 模型)
S (现状 / As-Is)：当前的业务流程是怎么跑的？
C (冲突 / 痛点)：当前流程遇到了什么瓶颈、卡点或异常？
Q (核心议题)：本次会议要解决的核心矛盾是什么？
A (方案 / To-Be)：会议确定的期望流程（未来态）是什么？
三、 需求深度拆解 (基于用户故事)
1. 业务需求层
（概括公司或部门层面的宏观诉求）
2. 用户与功能需求层 (按模块输出)
【模块名称】
User Story：作为 [角色]，我想要 [功能]，以便于 [价值]。
功能需求：需要哪些具体系统支持？
业务规则：提及的约束条件。
四、 智能需求排雷 (基于 Unhappy Path)
异常场景缺失：例如断网、数据为空、并发操作等。
前置/后置条件：权限校验、通知等。
非功能性缺失：安全性、性能要求等。
五、 会议闭环追踪 (基于 SMART 原则)
任务描述	责任人	截止时间/条件
[动作提取]	[人名/角色]	[时间节点]
<!-- SUMMARY_END -->
<!-- IA_START -->
六、 系统信息架构图 (Information Architecture)
请必须输出 Mermaid 层级树状流程图代码块，不要输出普通列表，不要使用 mindmap。格式必须严格如下：
```mermaid
graph LR
  A[系统信息架构] --> B[一级模块名称<br>【优先级：P0】]
  B --> C[二级页面或功能模块<br>【优先级：P0/P1/P2】]
  C --> D[具体字段或操作按钮]
  C --> E[具体业务规则]
  A --> F[另一个一级模块<br>【优先级：P1】]
  F --> G[二级页面或功能模块<br>【优先级：P1】]
```
要求：
1. 代码块语言必须是 mermaid。
2. Mermaid 类型必须是标准流程图，首行必须是 `graph LR`，从左到右展示层级关系。
3. 每个一级模块和二级模块必须标注【优先级：P0/P1/P2】。
4. P0 为核心流程必做，P1 为重要补充，P2 为边缘或延期体验优化。
5. 只能根据会议记录中出现的信息抽象节点；未提及的模块不要编造。
6. 当节点文字超过10个字符时，必须使用 `<br>` 进行手动换行，以防止图形渲染错乱。
7. 节点 ID 必须使用英文字母和数字，例如 A、B、C1，不要使用中文作为节点 ID。
<!-- IA_END -->"""

DEFAULT_MEETING_AGENT_PROMPT = (
    "你是一个专业的会议分析助手。\n"
    "请严格按照以下【会议文字记录】回答用户的问题。\n"
    "要求：1. 回复必须极度精简，直击要点；2. 绝不允许编造任何未在【会议文字记录】中出现的信息；"
    "3. 如果会议记录中没有相关信息，请直接回答'会议记录中未提及'。"
)

MAX_AGENT_TRANSCRIPT_CHARS = 28_000
MAX_AGENT_SUMMARY_CHARS = 6_000
MAX_AGENT_HISTORY_ITEMS = 6
MAX_AGENT_HISTORY_MESSAGE_CHARS = 1_200


class LLMServiceError(RuntimeError):
    """LLM 调用失败时抛出的业务异常。"""


class LLMService:
    """兼容 OpenAI SDK 的模型调用封装。"""

    def __init__(self) -> None:
        settings = get_settings()
        if not settings.llm_api_key:
            raise LLMServiceError("缺少必要环境变量：LLM_API_KEY")

        self.model = settings.llm_model
        client_kwargs = {"api_key": settings.llm_api_key}
        if settings.llm_base_url:
            client_kwargs["base_url"] = settings.llm_base_url
        # openai==1.35.x 内部会用旧版 httpx 的 proxies 参数初始化客户端；
        # 传入显式 httpx.Client 可兼容当前环境中的 httpx 0.28+。
        client_kwargs["http_client"] = httpx.Client()
        self.client = OpenAI(**client_kwargs)

    def summarize_requirements(self, transcript: list[dict[str, Any]]) -> dict[str, str]:
        """根据逐字稿提取需求分析和信息架构 Markdown。"""

        transcript_text = format_transcript_for_llm(transcript)
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                {"role": "user", "content": transcript_text},
            ],
            temperature=0.2,
        )
        content = strip_model_thinking(response.choices[0].message.content or "")
        return split_summary_sections(content)

    def answer_meeting_question(
        self,
        *,
        transcript: list[dict[str, Any]],
        summary_markdown: str | None,
        history: list[dict[str, str]],
        user_message: str,
    ) -> str:
        """基于当前会议上下文回答用户问题。"""

        messages = build_meeting_agent_messages(
            transcript=transcript,
            summary_markdown=summary_markdown,
            history=history,
            user_message=user_message,
        )

        response = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=0.1,
        )
        return strip_model_thinking(response.choices[0].message.content or "会议记录中未提及")


def load_meeting_agent_prompt() -> str:
    """动态读取会议 Agent 提示词文件，便于外部直接调整。"""

    settings = get_settings()
    prompt_path = settings.meeting_agent_prompt_path
    if not prompt_path.is_absolute():
        prompt_path = Path.cwd() / prompt_path

    try:
        content = prompt_path.read_text(encoding="utf-8").strip()
    except OSError:
        return DEFAULT_MEETING_AGENT_PROMPT
    return content or DEFAULT_MEETING_AGENT_PROMPT


def build_meeting_agent_messages(
    *,
    transcript: list[dict[str, Any]],
    summary_markdown: str | None,
    history: list[dict[str, str]],
    user_message: str,
) -> list[dict[str, str]]:
    """拼装会议 Agent 请求消息，确保提示词、会议上下文和用户问题边界清晰。"""

    context_message = build_meeting_context_message(
        transcript=transcript,
        summary_markdown=summary_markdown,
    )
    messages = [
        {"role": "system", "content": load_meeting_agent_prompt()},
        {"role": "user", "content": context_message},
        {"role": "assistant", "content": "已读取会议文字记录。"},
    ]
    messages.extend(_trim_chat_history(history))
    messages.append({"role": "user", "content": f"【用户问题】\n{user_message.strip()}"})
    return messages


def build_meeting_context_message(
    *,
    transcript: list[dict[str, Any]],
    summary_markdown: str | None,
) -> str:
    """构造会议上下文；超长逐字稿会保留开头和结尾并标记截断。"""

    transcript_text = _truncate_context(
        format_transcript_for_llm(transcript) or "会议记录中未提及",
        MAX_AGENT_TRANSCRIPT_CHARS,
        "会议文字记录",
    )
    summary_text = _truncate_context(
        summary_markdown or "暂无需求分析纪要。",
        MAX_AGENT_SUMMARY_CHARS,
        "系统需求分析纪要",
    )
    return (
        "以下内容是本轮回答唯一可依据的会议上下文。\n\n"
        "【会议文字记录】\n"
        f"{transcript_text}\n\n"
        "【系统需求分析纪要，仅作辅助参考】\n"
        f"{summary_text}"
    )


def _trim_chat_history(history: list[dict[str, str]]) -> list[dict[str, str]]:
    trimmed: list[dict[str, str]] = []
    for item in history[-MAX_AGENT_HISTORY_ITEMS:]:
        role = item.get("role")
        content = (item.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        trimmed.append({"role": role, "content": _truncate_context(content, MAX_AGENT_HISTORY_MESSAGE_CHARS, "历史消息")})
    return trimmed


def _truncate_context(content: str, max_chars: int, label: str) -> str:
    if len(content) <= max_chars:
        return content

    head_chars = int(max_chars * 0.62)
    tail_chars = max_chars - head_chars
    return (
        content[:head_chars].rstrip()
        + f"\n\n...[{label}过长，中间内容已截断]...\n\n"
        + content[-tail_chars:].lstrip()
    )


def format_transcript_for_llm(transcript: list[dict[str, Any]]) -> str:
    """将标准逐字稿数组转换为模型更容易阅读的文本。"""

    lines: list[str] = []
    for item in transcript:
        speaker = item.get("speaker", "unknown")
        text = item.get("text", "")
        if text:
            start_time = _format_timestamp(item.get("start_time") or 0)
            end_time = _format_timestamp(item.get("end_time") or item.get("start_time") or 0)
            lines.append(f"[{start_time}-{end_time}] {speaker}: {text}")
    return "\n".join(lines)


def strip_model_thinking(content: str) -> str:
    """移除部分推理模型返回的思考过程，只保留可展示回答。"""

    cleaned = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL | re.IGNORECASE)
    return cleaned.strip()


def split_summary_sections(content: str) -> dict[str, str]:
    """按 LLM 输出标识切分需求分析和信息架构。"""

    summary = _extract_between_markers(content, "SUMMARY")
    ia = _extract_between_markers(content, "IA")
    return {
        "summary_content": summary or content.strip(),
        "ia_content": ensure_mermaid_graph(ia),
        "raw_content": content.strip(),
    }


def ensure_mermaid_graph(content: str) -> str:
    """确保信息架构内容包含 Mermaid graph LR 层级树状图。"""

    cleaned = content.strip()
    if not cleaned:
        return ""
    if re.search(r"```mermaid\s+graph\s+(?:LR|TD)", cleaned, flags=re.IGNORECASE):
        return _wrap_existing_graph_nodes(cleaned)

    outline_nodes = _extract_outline_nodes(cleaned)
    graph_lines = _outline_nodes_to_graph_lines(outline_nodes)

    return (
        "六、 系统信息架构图 (Information Architecture)\n\n"
        "```mermaid\n"
        "graph LR\n"
        "  A[系统信息架构]\n"
        f"{graph_lines}\n"
        "```"
    )


def _extract_outline_nodes(content: str) -> list[tuple[int, str]]:
    nodes: list[tuple[int, str]] = []
    in_mermaid = False
    in_mindmap = False
    in_graph = False

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if line.startswith("```"):
            in_mermaid = line.lower().startswith("```mermaid")
            in_mindmap = False
            in_graph = False
            continue
        if not line or line.startswith("<!--"):
            continue
        if in_mermaid and re.match(r"^graph\s+(?:LR|TD)\b", line, flags=re.IGNORECASE):
            in_graph = True
            continue
        if in_mermaid and line.lower() == "mindmap":
            in_mindmap = True
            continue
        if in_graph and "-->" in line:
            for label in re.findall(r"\[([^\]]+)\]", line):
                if label != "系统信息架构":
                    nodes.append((2, _sanitize_graph_label(label)))
            continue
        if in_mindmap:
            if line.startswith("root("):
                continue
            nodes.append((_infer_outline_level(raw_line), _sanitize_graph_label(line)))
            continue

        line = re.sub(r"^#{1,6}\s*", "", line)
        line = re.sub(r"^[-*+]\s*", "", line)
        line = re.sub(r"^\d+[.、]\s*", "", line)
        line = line.strip()
        if not line:
            continue
        if "系统信息架构图" in line and "【优先级：" not in line:
            continue
        level = _infer_outline_level(raw_line)
        nodes.append((level, _sanitize_graph_label(line)))

    return nodes or [(1, "会议记录中未提及【优先级：P2】")]


def _outline_nodes_to_graph_lines(nodes: list[tuple[int, str]]) -> str:
    lines: list[str] = []
    parent_by_level: dict[int, str] = {0: "A"}
    for index, (level, label) in enumerate(nodes, start=1):
        node_id = f"N{index}"
        safe_level = max(1, level)
        parent_id = parent_by_level.get(safe_level - 1, "A")
        lines.append(f"  {parent_id} --> {node_id}[{label}]")
        parent_by_level[safe_level] = node_id
    return "\n".join(lines)


def _wrap_existing_graph_nodes(content: str) -> str:
    lines: list[str] = []
    in_mermaid = False
    in_graph = False

    for raw_line in content.splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("```"):
            in_mermaid = stripped.lower().startswith("```mermaid")
            in_graph = False
            lines.append(raw_line)
            continue
        if in_mermaid and re.match(r"^graph\s+", stripped, flags=re.IGNORECASE):
            in_graph = True
            lines.append("graph LR")
            continue
        if in_mermaid and in_graph and stripped:
            lines.append(re.sub(r"\[([^\]]+)\]", lambda match: f"[{_sanitize_graph_label(match.group(1))}]", raw_line))
            continue
        lines.append(raw_line)

    return "\n".join(lines)


def _wrap_existing_mindmap_nodes(content: str) -> str:
    lines: list[str] = []
    in_mermaid = False
    in_mindmap = False

    for raw_line in content.splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("```"):
            in_mermaid = stripped.lower().startswith("```mermaid")
            in_mindmap = False
            lines.append(raw_line)
            continue
        if in_mermaid and stripped == "mindmap":
            in_mindmap = True
            lines.append(raw_line)
            continue
        if in_mermaid and in_mindmap and stripped and not stripped.startswith("root("):
            leading = raw_line[:len(raw_line) - len(raw_line.lstrip(" "))]
            lines.append(f"{leading}{_insert_mermaid_line_breaks(stripped)}")
            continue
        lines.append(raw_line)

    return "\n".join(lines)


def _infer_outline_level(raw_line: str) -> int:
    leading_spaces = len(raw_line) - len(raw_line.lstrip(" "))
    stripped = raw_line.strip()
    if re.match(r"^[-*+]\s+", stripped):
        return min(5, 2 + leading_spaces // 2)
    if re.match(r"^\d+[.、]\s+", stripped):
        return min(5, 2 + leading_spaces // 2)
    return min(5, 2 + leading_spaces // 2)


def _sanitize_graph_label(value: str) -> str:
    sanitized = value.replace("(", "（").replace(")", "）").replace("[", "【").replace("]", "】")
    return _insert_mermaid_line_breaks(sanitized)


def _sanitize_mindmap_node(value: str) -> str:
    return _sanitize_graph_label(value)


def _insert_mermaid_line_breaks(value: str, max_chars: int = 10) -> str:
    normalized = value.replace("<br>", "")
    if len(normalized) <= max_chars:
        return normalized

    priority_match = re.search(r"(\s*(?:✅\s*)?(?:P[0-2]|【优先级：P[0-2]】))$", normalized)
    priority_suffix = priority_match.group(1) if priority_match else ""
    node_text = normalized[:priority_match.start()].rstrip() if priority_match else normalized
    chunks = [node_text[index:index + max_chars] for index in range(0, len(node_text), max_chars)]
    wrapped = "<br>".join(chunk for chunk in chunks if chunk)
    return f"{wrapped}{priority_suffix}" if priority_suffix else wrapped


def _extract_between_markers(content: str, marker: str) -> str:
    pattern = rf"<!--\s*{marker}_START\s*-->(.*?)<!--\s*{marker}_END\s*-->"
    match = re.search(pattern, content, flags=re.DOTALL | re.IGNORECASE)
    return match.group(1).strip() if match else ""


def _format_timestamp(milliseconds: Any) -> str:
    """将毫秒级时间戳格式化为 mm:ss。"""

    try:
        total_seconds = max(0, int(float(milliseconds)) // 1000)
    except (TypeError, ValueError):
        total_seconds = 0
    minutes = total_seconds // 60
    seconds = total_seconds % 60
    return f"{minutes:02d}:{seconds:02d}"
