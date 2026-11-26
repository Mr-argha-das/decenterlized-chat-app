"""Lightweight zero-dependency Prometheus metrics collector & text exposition formatter."""
import re
import threading
import time
from collections import defaultdict

_UUID_SEGMENT_RE = re.compile(
    r"/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=/|$)"
)
_CHUNK_INDEX_RE = re.compile(r"(/attachments/upload/[^/]+)/\d+")

LATENCY_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0)


def normalize_route_path(path: str) -> str:
    norm = _CHUNK_INDEX_RE.sub(r"\1/{chunk}", path)
    norm = _UUID_SEGMENT_RE.sub("/{id}", norm)
    if norm.startswith("/.well-known/user/"):
        return "/.well-known/user/{username}"
    if norm.startswith("/users/check-username/"):
        return "/users/check-username/{username}"
    if norm.startswith("/users/profile/"):
        return "/users/profile/{identifier}"
    if norm.startswith("/groups/invite/"):
        return "/groups/invite/{code}"
    if norm.startswith("/groups/join/"):
        return "/groups/join/{code}"
    return norm


class MetricsRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._started_at = time.time()
        self._http_requests_total: dict[tuple[str, str, int], int] = defaultdict(int)
        self._http_duration_sum: dict[tuple[str, str], float] = defaultdict(float)
        self._http_duration_count: dict[tuple[str, str], int] = defaultdict(int)
        self._http_duration_buckets: dict[tuple[str, str, float], int] = defaultdict(int)
        self._counters: dict[str, int] = defaultdict(int)
        self._gauges: dict[str, float] = defaultdict(float)

    def inc_counter(self, name: str, delta: int = 1) -> None:
        with self._lock:
            self._counters[name] += delta

    def set_gauge(self, name: str, value: float) -> None:
        with self._lock:
            self._gauges[name] = value

    def observe_http_request(
        self, method: str, path: str, status_code: int, duration_seconds: float
    ) -> None:
        norm_path = normalize_route_path(path)
        with self._lock:
            self._http_requests_total[(method, norm_path, status_code)] += 1
            key = (method, norm_path)
            self._http_duration_sum[key] += duration_seconds
            self._http_duration_count[key] += 1
            for bound in LATENCY_BUCKETS:
                if duration_seconds <= bound:
                    self._http_duration_buckets[(method, norm_path, bound)] += 1

    def render_prometheus(self, extra_gauges: dict[str, float] | None = None) -> str:
        lines: list[str] = []
        uptime = max(0.0, time.time() - self._started_at)

        lines.append("# HELP relaychat_uptime_seconds Process uptime in seconds.")
        lines.append("# TYPE relaychat_uptime_seconds gauge")
        lines.append(f"relaychat_uptime_seconds {uptime:.2f}")

        with self._lock:
            req_copy = dict(self._http_requests_total)
            dur_sum = dict(self._http_duration_sum)
            dur_cnt = dict(self._http_duration_count)
            dur_bkt = dict(self._http_duration_buckets)
            counters_copy = dict(self._counters)
            gauges_copy = dict(self._gauges)

        lines.append("# HELP relaychat_http_requests_total Total HTTP requests handled.")
        lines.append("# TYPE relaychat_http_requests_total counter")
        for (method, route, code), count in sorted(req_copy.items()):
            safe_route = route.replace('"', '\\"')
            lines.append(
                f'relaychat_http_requests_total{{method="{method}",route="{safe_route}",status="{code}"}} {count}'
            )

        lines.append("# HELP relaychat_http_request_duration_seconds HTTP request latency histogram.")
        lines.append("# TYPE relaychat_http_request_duration_seconds histogram")
        for (method, route), total_cnt in sorted(dur_cnt.items()):
            safe_route = route.replace('"', '\\"')
            for bound in LATENCY_BUCKETS:
                b_cnt = dur_bkt.get((method, route, bound), 0)
                lines.append(
                    f'relaychat_http_request_duration_seconds_bucket{{method="{method}",route="{safe_route}",le="{bound}"}} {b_cnt}'
                )
            lines.append(
                f'relaychat_http_request_duration_seconds_bucket{{method="{method}",route="{safe_route}",le="+Inf"}} {total_cnt}'
            )
            lines.append(
                f'relaychat_http_request_duration_seconds_sum{{method="{method}",route="{safe_route}"}} {dur_sum[(method, route)]:.6f}'
            )
            lines.append(
                f'relaychat_http_request_duration_seconds_count{{method="{method}",route="{safe_route}"}} {total_cnt}'
            )

        app_counter_defs = {
            "messages_relayed_total": "Total E2EE messages stored and relayed.",
            "attachments_completed_total": "Total encrypted blob uploads finalized.",
            "statuses_posted_total": "Total 24-hour encrypted statuses posted.",
            "push_notifications_sent_total": "Total Web Push notifications dispatched.",
            "federation_events_received_total": "Total inbound S2S federation events verified.",
            "rate_limited_requests_total": "Total requests rejected by sliding-window rate limiter.",
            "file_scans_total": "Total encrypted attachment scans executed.",
        }
        for key, help_text in app_counter_defs.items():
            metric_name = f"relaychat_{key}"
            lines.append(f"# HELP {metric_name} {help_text}")
            lines.append(f"# TYPE {metric_name} counter")
            lines.append(f"{metric_name} {counters_copy.get(key, 0)}")

        merged_gauges = {**gauges_copy, **(extra_gauges or {})}
        for key, val in sorted(merged_gauges.items()):
            metric_name = key if key.startswith("relaychat_") else f"relaychat_{key}"
            lines.append(f"# TYPE {metric_name} gauge")
            lines.append(f"{metric_name} {val}")

        return "\n".join(lines) + "\n"


metrics_registry = MetricsRegistry()
