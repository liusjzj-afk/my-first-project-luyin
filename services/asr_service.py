"""
阿里云智能语音交互 - 录音文件识别服务封装。

职责：
1. 将本地音频上传到 OSS 并生成阿里云 ASR 可访问的公网 URL。
2. 调用录音文件识别 SubmitTask 创建异步识别任务。
3. 调用 GetTaskResult 查询任务状态与结果。
4. 将阿里云返回结果标准化为前端需要的逐字稿数组。

需要用户填写的环境变量：
- ALIYUN_AK: 阿里云 AccessKey ID
- ALIYUN_SK: 阿里云 AccessKey Secret
- ALIYUN_APPKEY: 智能语音交互项目 AppKey
- ALIYUN_REGION_ID: OSS 地域，默认 cn-shanghai
- ALIYUN_ASR_REGION_ID: 录音文件识别 API 地域，默认 cn-shanghai
- ALIYUN_OSS_ENDPOINT: OSS Endpoint，例如 oss-cn-shanghai.aliyuncs.com
- ALIYUN_OSS_BUCKET: OSS Bucket 名称
- ALIYUN_OSS_PUBLIC_BASE_URL: 可选，自定义公网域名，例如 https://audio.example.com
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import oss2
from aliyunsdkcore.client import AcsClient
from aliyunsdkcore.request import CommonRequest
from dotenv import load_dotenv


class ASRServiceError(RuntimeError):
    """ASR 服务调用失败时抛出的业务异常。"""


def _env_value(name: str, default: str = "") -> str:
    """读取环境变量，并把示例占位文案视为未配置。"""

    value = os.getenv(name, default).strip()
    if value.startswith("请填写"):
        return ""
    return value


@dataclass(frozen=True)
class ASRSettings:
    """阿里云 ASR 与 OSS 配置。"""

    aliyun_ak: str
    aliyun_sk: str
    aliyun_appkey: str
    region_id: str = "cn-shanghai"
    asr_region_id: str = "cn-shanghai"
    oss_endpoint: str | None = None
    oss_bucket: str | None = None
    oss_public_base_url: str | None = None
    # 智能语音交互录音文件识别 POP API 固定信息。
    asr_domain: str = "filetrans.cn-shanghai.aliyuncs.com"
    asr_product: str = "nls-filetrans"
    asr_version: str = "2018-08-17"

    @classmethod
    def from_env(cls) -> "ASRSettings":
        """从环境变量读取配置，并对必填项做清晰校验。"""

        load_dotenv()

        aliyun_ak = _env_value("ALIYUN_AK")
        aliyun_sk = _env_value("ALIYUN_SK")
        aliyun_appkey = _env_value("ALIYUN_APPKEY")

        missing = [
            name
            for name, value in {
                "ALIYUN_AK": aliyun_ak,
                "ALIYUN_SK": aliyun_sk,
                "ALIYUN_APPKEY": aliyun_appkey,
            }.items()
            if not value
        ]
        if missing:
            raise ASRServiceError(f"缺少必要环境变量：{', '.join(missing)}")

        region_id = _env_value("ALIYUN_REGION_ID", "cn-shanghai")
        asr_region_id = _env_value("ALIYUN_ASR_REGION_ID", "cn-shanghai")
        return cls(
            aliyun_ak=aliyun_ak,
            aliyun_sk=aliyun_sk,
            aliyun_appkey=aliyun_appkey,
            region_id=region_id,
            asr_region_id=asr_region_id,
            oss_endpoint=_env_value("ALIYUN_OSS_ENDPOINT") or None,
            oss_bucket=_env_value("ALIYUN_OSS_BUCKET") or None,
            oss_public_base_url=_env_value("ALIYUN_OSS_PUBLIC_BASE_URL") or None,
            asr_domain=f"filetrans.{asr_region_id}.aliyuncs.com",
        )


class AliyunASRService:
    """阿里云录音文件识别客户端。"""

    def __init__(self, settings: ASRSettings | None = None) -> None:
        self.settings = settings or ASRSettings.from_env()
        self.client = AcsClient(
            ak=self.settings.aliyun_ak,
            secret=self.settings.aliyun_sk,
            region_id=self.settings.asr_region_id,
        )

    def upload_audio_to_oss(self, local_file_path: str, object_key: str | None = None) -> str:
        """
        上传本地音频到 OSS，并返回 ASR 能访问的公网 URL。

        如果配置了 ALIYUN_OSS_PUBLIC_BASE_URL，会返回稳定公网地址；
        否则返回一个 2 小时有效的签名 URL，足够 SubmitTask 拉取音频。
        """

        if not self.settings.oss_endpoint or not self.settings.oss_bucket:
            raise ASRServiceError(
                "缺少 OSS 配置，请填写 ALIYUN_OSS_ENDPOINT 和 ALIYUN_OSS_BUCKET"
            )

        file_path = Path(local_file_path)
        if not file_path.exists():
            raise ASRServiceError(f"音频文件不存在：{local_file_path}")

        key = object_key or f"systemreq-copilot/{file_path.name}"
        auth = oss2.Auth(self.settings.aliyun_ak, self.settings.aliyun_sk)
        bucket = oss2.Bucket(auth, self.settings.oss_endpoint, self.settings.oss_bucket)
        bucket.put_object_from_file(key, str(file_path))

        if self.settings.oss_public_base_url:
            return f"{self.settings.oss_public_base_url.rstrip('/')}/{key}"

        # 签名 URL 仅用于 ASR 服务端拉取音频，不建议暴露给前端长期使用。
        return bucket.sign_url("GET", key, 7200)

    def submit_task(self, audio_url: str, *, enable_diarization: bool = True) -> str:
        """
        提交录音文件识别任务，返回阿里云 TaskId。

        说明：
        - 项目需求中写的是 DiarizationEnabled=True。
        - 智能语音交互“录音文件识别”接口对应的说话人/声道自动分离参数为 auto_split。
        - 因此这里用 enable_diarization 控制 auto_split=True，满足“开启说话人分离”的业务要求。
        """

        task_payload: dict[str, Any] = {
            "appkey": self.settings.aliyun_appkey,
            "file_link": audio_url,
            "version": "4.0",
            # 开启说话人分离/声道自动切分。若后续切到新 ASR API，可映射为 DiarizationEnabled=True。
            "auto_split": bool(enable_diarization),
            "enable_words": False,
            "enable_sample_rate_adaptive": True,
            "enable_punctuation_prediction": True,
            "enable_inverse_text_normalization": True,
        }

        response = self._call_rpc_api("SubmitTask", task_payload)
        status_text = response.get("StatusText")
        if status_text != "SUCCESS":
            raise ASRServiceError(f"提交 ASR 任务失败：{response}")

        task_id = response.get("TaskId")
        if not task_id:
            raise ASRServiceError(f"阿里云未返回 TaskId：{response}")

        return str(task_id)

    def get_task_result(self, task_id: str) -> dict[str, Any]:
        """查询 ASR 任务状态和结果。"""

        return self._call_get_result_api(task_id)

    def normalize_transcript(self, aliyun_result: dict[str, Any]) -> list[dict[str, Any]]:
        """
        将阿里云结果转为统一逐字稿格式：
        [{"speaker": "spk_1", "start_time": 1200, "end_time": 3500, "text": "..."}]
        """

        result_payload = aliyun_result.get("Result")
        if isinstance(result_payload, str):
            try:
                result_payload = json.loads(result_payload)
            except json.JSONDecodeError as exc:
                raise ASRServiceError("ASR Result 不是合法 JSON") from exc

        sentences = []
        if isinstance(result_payload, dict):
            sentences = result_payload.get("Sentences") or result_payload.get("sentences") or []

        normalized: list[dict[str, Any]] = []
        for item in sentences:
            if not isinstance(item, dict):
                continue

            text = item.get("Text") or item.get("text") or ""
            if not text:
                continue

            speaker_raw = (
                item.get("SpeakerId")
                or item.get("speaker_id")
                or item.get("ChannelId")
                or item.get("channel_id")
                or 0
            )
            start_time = item.get("BeginTime") or item.get("begin_time") or item.get("StartTime") or 0
            end_time = item.get("EndTime") or item.get("end_time") or 0

            normalized.append(
                {
                    "speaker": f"spk_{speaker_raw}",
                    "start_time": int(start_time),
                    "end_time": int(end_time),
                    "text": text,
                    "raw": item,
                }
            )

        return normalized

    def _call_rpc_api(self, action: str, task_payload: dict[str, Any]) -> dict[str, Any]:
        """调用阿里云 POP/RPC API，统一处理请求和 JSON 解析。"""

        request = CommonRequest()
        request.set_domain(self.settings.asr_domain)
        request.set_version(self.settings.asr_version)
        request.set_product(self.settings.asr_product)
        request.set_action_name(action)
        request.set_method("POST")
        request.set_protocol_type("https")
        request.add_body_params("Task", json.dumps(task_payload, ensure_ascii=False))

        raw_response = self.client.do_action_with_exception(request)
        try:
            return json.loads(raw_response.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ASRServiceError(f"阿里云响应解析失败：{raw_response!r}") from exc

    def _call_get_result_api(self, task_id: str) -> dict[str, Any]:
        """调用 GetTaskResult。官方示例要求使用 TaskId 查询参数。"""

        request = CommonRequest()
        request.set_domain(self.settings.asr_domain)
        request.set_version(self.settings.asr_version)
        request.set_product(self.settings.asr_product)
        request.set_action_name("GetTaskResult")
        request.set_method("GET")
        request.set_protocol_type("https")
        request.add_query_param("TaskId", task_id)

        raw_response = self.client.do_action_with_exception(request)
        try:
            return json.loads(raw_response.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ASRServiceError(f"阿里云响应解析失败：{raw_response!r}") from exc
