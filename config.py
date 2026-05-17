"""
SystemReq-Copilot 应用配置。

所有敏感信息均通过环境变量读取，请不要写死在代码里。
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """后端运行配置。"""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # 数据库
    database_url: str = "sqlite:///./systemreq_copilot.db"

    # 文件上传
    upload_dir: Path = Path("./uploads")
    max_upload_size_mb: int = 100

    # LLM：兼容 OpenAI SDK 格式的接口
    # 需要用户填写：
    # LLM_API_KEY=你的模型 API Key
    # LLM_BASE_URL=https://api.openai.com/v1 或兼容 OpenAI 的服务地址
    # LLM_MODEL=gpt-4o-mini 或供应商提供的模型名
    llm_api_key: str = ""
    llm_base_url: str | None = None
    llm_model: str = "gpt-4o-mini"
    meeting_agent_prompt_path: Path = Path("./meeting_agent_prompt.md")
    summary_prompt_dir: Path = Path("./prompts")

    # 商业化任务队列：默认本地线程兼容 MVP；生产建议 ENABLE_CELERY=true。
    enable_celery: bool = False
    celery_broker_url: str = "redis://localhost:6379/0"
    celery_result_backend: str = "redis://localhost:6379/1"

    # 多租户占位：未接入鉴权前使用默认租户，后续由认证中间件注入。
    default_tenant_id: str = "public"
    default_user_id: str = "local-user"

    # 阿里云 ASR/OSS 环境变量在 services/asr_service.py 中读取：
    # ALIYUN_AK, ALIYUN_SK, ALIYUN_APPKEY, ALIYUN_REGION_ID,
    # ALIYUN_OSS_ENDPOINT, ALIYUN_OSS_BUCKET, ALIYUN_OSS_PUBLIC_BASE_URL


@lru_cache
def get_settings() -> Settings:
    """缓存配置，避免每次请求重复读取 .env。"""

    return Settings()
