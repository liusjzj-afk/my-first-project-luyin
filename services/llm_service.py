"""
LLM 需求提取与会议 Agent 对话服务。

使用 openai Python 包，并通过 base_url 支持任何兼容 OpenAI SDK 的模型服务。
"""

from __future__ import annotations

from typing import Any

import httpx
from openai import OpenAI

from config import get_settings


SUMMARY_SYSTEM_PROMPT = """你是一个资深的 IT 需求分析师。请阅读以下会议记录，提取并梳理其中的系统需求。必须以 Markdown 格式输出，包含以下四个固定的二级标题：
1. 业务背景与痛点 (总结为什么需要做这个系统/功能)
2. 核心功能需求 (使用列表形式，清晰描述系统需要具备的功能模块及用户交互流程)
3. 非功能需求 (如性能、安全、界面等要求，若无则写无)
4. 遗留与待确认问题 (识别出会上讨论产生分歧或未敲定的细节)"""


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

    def summarize_requirements(self, transcript: list[dict[str, Any]]) -> str:
        """根据逐字稿提取结构化系统需求 Markdown。"""

        transcript_text = format_transcript_for_llm(transcript)
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                {"role": "user", "content": transcript_text},
            ],
            temperature=0.2,
        )
        return response.choices[0].message.content or ""

    def answer_meeting_question(
        self,
        *,
        transcript: list[dict[str, Any]],
        summary_markdown: str | None,
        history: list[dict[str, str]],
        user_message: str,
    ) -> str:
        """基于当前会议上下文回答用户问题。"""

        transcript_text = format_transcript_for_llm(transcript)
        summary_text = summary_markdown or "暂无需求分析纪要。"
        system_prompt = (
            "你是这场需求讨论会的 AI 助手。以下是完整的会议逐字稿：\n"
            f"{transcript_text}\n\n"
            "以下是已生成的系统需求分析纪要，可作为辅助参考：\n"
            f"{summary_text}\n\n"
            "请根据原文，准确回答用户关于本次会议细节的问题。"
            "如果原文没有提到，请直接回答'会议中未提及'，不可编造。"
        )

        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(history)
        messages.append({"role": "user", "content": user_message})

        response = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=0.1,
        )
        return response.choices[0].message.content or "会议中未提及"


def format_transcript_for_llm(transcript: list[dict[str, Any]]) -> str:
    """将标准逐字稿数组转换为模型更容易阅读的文本。"""

    lines: list[str] = []
    for item in transcript:
        speaker = item.get("speaker", "unknown")
        text = item.get("text", "")
        if text:
            lines.append(f"{speaker}: {text}")
    return "\n".join(lines)
