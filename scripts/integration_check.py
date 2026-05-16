"""轻量联调脚本：检查配置、LLM 连通性，不打印任何密钥。"""

from __future__ import annotations

import sys
from pathlib import Path

from dotenv import dotenv_values

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from services.llm_service import LLMService


def main() -> None:
    env = dotenv_values(".env")
    required_keys = [
        "ALIYUN_AK",
        "ALIYUN_SK",
        "ALIYUN_APPKEY",
        "ALIYUN_REGION_ID",
        "ALIYUN_OSS_ENDPOINT",
        "ALIYUN_OSS_BUCKET",
        "LLM_API_KEY",
        "LLM_BASE_URL",
        "LLM_MODEL",
    ]
    missing = [
        key
        for key in required_keys
        if not env.get(key) or str(env.get(key)).startswith("请填写")
    ]
    print("CONFIG_MISSING=" + ",".join(missing))

    llm = LLMService()
    summary = llm.summarize_requirements(
        [
            {
                "speaker": "spk_1",
                "text": "我们需要做一个会议音频上传系统，自动转写并提取系统需求。",
            },
            {
                "speaker": "spk_2",
                "text": "前端需要展示逐字稿、需求纪要，并支持继续追问会议细节。",
            },
        ]
    )
    print("LLM_OK")
    print(summary["summary_content"][:800])
    print(summary["ia_content"][:800])


if __name__ == "__main__":
    main()
