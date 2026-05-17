"""Lightweight event bus for meeting status updates.

The default implementation is in-memory for local development. Production can
replace this with Redis Pub/Sub while preserving the publish/subscribe API used
by SSE and workers.
"""

from __future__ import annotations

import json
import queue
import threading
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import redis

from config import get_settings


@dataclass(frozen=True)
class MeetingEvent:
    event: str
    meeting_id: str
    payload: dict[str, Any]


_subscribers: dict[str, list[queue.Queue[MeetingEvent]]] = defaultdict(list)
_lock = threading.Lock()


def publish_meeting_event(meeting_id: str, event: str, payload: dict[str, Any]) -> None:
    message = MeetingEvent(event=event, meeting_id=meeting_id, payload=payload)
    if _redis_enabled():
        try:
            _redis_client().publish(_channel_name(meeting_id), json.dumps(message.__dict__, ensure_ascii=False))
            return
        except redis.RedisError:
            pass

    with _lock:
        subscribers = list(_subscribers.get(meeting_id, []))

    for subscriber in subscribers:
        subscriber.put(message)


def subscribe_meeting_events(meeting_id: str, *, timeout_seconds: float = 20.0) -> Iterator[str]:
    if _redis_enabled():
        try:
            yield from _subscribe_redis_events(meeting_id, timeout_seconds=timeout_seconds)
            return
        except redis.RedisError:
            pass

    subscriber: queue.Queue[MeetingEvent] = queue.Queue()
    with _lock:
        _subscribers[meeting_id].append(subscriber)

    try:
        yield _format_sse("connected", {"meeting_id": meeting_id})
        while True:
            try:
                message = subscriber.get(timeout=timeout_seconds)
                yield _format_sse(message.event, message.payload)
            except queue.Empty:
                yield ": heartbeat\n\n"
    finally:
        with _lock:
            meeting_subscribers = _subscribers.get(meeting_id, [])
            if subscriber in meeting_subscribers:
                meeting_subscribers.remove(subscriber)
            if not meeting_subscribers:
                _subscribers.pop(meeting_id, None)


def _format_sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _redis_enabled() -> bool:
    return get_settings().enable_celery


def _redis_client() -> redis.Redis:
    return redis.Redis.from_url(get_settings().celery_broker_url, decode_responses=True)


def _channel_name(meeting_id: str) -> str:
    return f"meeting-events:{meeting_id}"


def _subscribe_redis_events(meeting_id: str, *, timeout_seconds: float) -> Iterator[str]:
    yield _format_sse("connected", {"meeting_id": meeting_id})
    pubsub = _redis_client().pubsub()
    pubsub.subscribe(_channel_name(meeting_id))
    try:
        while True:
            message = pubsub.get_message(timeout=timeout_seconds)
            if message is None:
                yield ": heartbeat\n\n"
                continue
            if message.get("type") != "message":
                continue
            raw_data = message.get("data")
            if not isinstance(raw_data, str):
                continue
            event_data = json.loads(raw_data)
            yield _format_sse(event_data["event"], event_data["payload"])
    finally:
        pubsub.close()
