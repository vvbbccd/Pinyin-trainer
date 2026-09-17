"""WSGI application: REST routes, CORS, and static file serving.

One process serves both the API and the browser client, so the default setup is
same-origin and needs no proxy. CORS is enabled for /api/* anyway, which lets the
frontend be served separately (for example on python -m http.server) while still
talking to this backend.
"""

from __future__ import annotations

import json
import mimetypes
import posixpath
import re
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__
from .api import Api, ApiError
from .db import Database
from .repository import DEFAULT_USERNAME, Repository

# Directories that must never be served as static files: server code, build
# inputs and state, tooling and dependencies.
BLOCKED_PREFIXES = ("/server", "/tools", "/var", "/.tmp", "/node_modules", "/.git")
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")


@dataclass
class Request:
    method: str
    path: str
    query: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    params: dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    user_id: int = 1
    _json: Any = None
    _parsed: bool = False

    def json(self) -> Any:
        if not self._parsed:
            self._parsed = True
            if not self.body:
                self._json = None
            else:
                try:
                    self._json = json.loads(self.body.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    self._json = None
        return self._json


class Router:
    """Tiny path router supporting ``:param`` segments."""

    def __init__(self):
        self.routes: list[tuple[str, re.Pattern, Callable]] = []

    def add(self, method: str, pattern: str, handler: Callable) -> None:
        names: list[str] = []

        def replace(match: re.Match) -> str:
            names.append(match.group(1))
            return "([^/]+)"

        regex = re.compile(f"^{re.sub(r':([A-Za-z_][A-Za-z0-9_]*)', replace, pattern)}/?$")
        self.routes.append((method.upper(), regex, (handler, names)))

    def match(self, method: str, path: str):
        allowed = set()
        for route_method, regex, (handler, names) in self.routes:
            found = regex.match(path)
            if not found:
                continue
            if route_method != method.upper():
                allowed.add(route_method)
                continue
            params = {name: unquote(value) for name, value in zip(names, found.groups())}
            return handler, params
        if allowed:
            raise ApiError(405, f"method not allowed; try {', '.join(sorted(allowed))}")
        return None, None


class Application:
    def __init__(self, db: Database, root: Path, static: bool = True):
        self.db = db
        self.root = Path(root).resolve()
        self.serve_static = static
        self.repo = Repository(db)
        self.api = Api(self.repo)
        self.router = Router()
        for method, pattern, handler in self.api.routes():
            self.router.add(method, pattern, handler)
        if not db.initialised:
            db.init_schema()
        self.repo.engine.warm_up()
        self.default_user_id = self.repo.ensure_user(DEFAULT_USERNAME)

    # ------------------------------------------------------------- WSGI --

    def __call__(self, environ, start_response):
        method = environ.get("REQUEST_METHOD", "GET").upper()
        parsed = urlparse(environ.get("PATH_INFO", "/") or "/")
        path = parsed.path or "/"
        raw_query = environ.get("QUERY_STRING", "")

        if method == "OPTIONS":
            start_response("204 No Content", self._preflight_headers())
            return [b""]

        if path.startswith("/api"):
            return self._handle_api(environ, start_response, method, path, raw_query)

        if self.serve_static and method in SAFE_METHODS:
            return self._serve_static(environ, start_response, method, path)

        return self._respond(start_response, 405, {"error": "method not allowed"}, method)

    # -------------------------------------------------------------- API --

    def _handle_api(self, environ, start_response, method, path, raw_query):
        query = {key: values[-1] for key, values in parse_qs(raw_query).items()}
        headers = {
            key[5:].replace("_", "-").lower(): value
            for key, value in environ.items()
            if key.startswith("HTTP_")
        }
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = 0
        body = environ["wsgi.input"].read(length) if length > 0 else b""

        request = Request(
            method=method,
            path=path,
            query=query,
            headers=headers,
            body=body,
            user_id=self._resolve_user(query, headers),
        )

        try:
            # HEAD mirrors GET, but the body is dropped in _respond
            routing_method = "GET" if method == "HEAD" else method
            handler, params = self.router.match(routing_method, path)
            if handler is None:
                raise ApiError(404, f"no such endpoint: {routing_method} {path}")
            request.params = params
            status, payload = handler(request)
        except ApiError as error:
            return self._respond(
                start_response, error.status,
                {"error": error.message, "code": error.code}, method,
            )
        except Exception as error:  # noqa: BLE001 - returned as a 500, never swallowed
            traceback.print_exc()
            return self._respond(
                start_response, 500,
                {"error": f"{type(error).__name__}: {error}", "code": "internal_error"}, method,
            )

        return self._respond(start_response, status, payload, method)

    def _resolve_user(self, query: dict, headers: dict) -> int:
        """No auth yet: one local user, overridable for future multi-user work."""
        candidate = query.get("user") or headers.get("x-user") or headers.get("x-user-id")
        if candidate:
            try:
                return int(candidate)
            except ValueError:
                row = self.db.query_one("SELECT id FROM users WHERE username = ?", (candidate,))
                if row:
                    return int(row["id"])
        return self.default_user_id

    def _respond(self, start_response, status: int, payload: Any, method: str):
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        headers = [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", str(len(body))),
            *self._cors_headers(),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
        ]
        start_response(self._status_line(status), headers)
        return [b""] if method == "HEAD" else [body]

    @staticmethod
    def _status_line(status: int) -> str:
        from http import HTTPStatus
        try:
            phrase = HTTPStatus(status).phrase
        except ValueError:
            phrase = "Unknown"
        return f"{status} {phrase}"

    def _cors_headers(self) -> list[tuple[str, str]]:
        return [
            ("Access-Control-Allow-Origin", "*"),
            ("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"),
            ("Access-Control-Allow-Headers", "Content-Type, X-User, X-User-Id"),
            ("Access-Control-Max-Age", "600"),
        ]

    def _preflight_headers(self) -> list[tuple[str, str]]:
        return [*self._cors_headers(), ("Content-Length", "0")]

    # ----------------------------------------------------------- static --

    def _serve_static(self, environ, start_response, method, path):
        if any(path == prefix or path.startswith(f"{prefix}/") for prefix in BLOCKED_PREFIXES):
            return self._plain(start_response, 404, "Not found", method)
        if "/." in path:
            return self._plain(start_response, 404, "Not found", method)

        relative = posixpath.normpath(unquote(path)).lstrip("/")
        candidate = (self.root / relative).resolve() if relative else self.root
        if candidate.is_dir():
            candidate = candidate / "index.html"

        # path traversal guard: the resolved file must stay inside the root
        try:
            candidate.relative_to(self.root)
        except ValueError:
            return self._plain(start_response, 403, "Forbidden", method)

        if not candidate.is_file():
            return self._plain(start_response, 404, "Not found", method)

        content_type, _ = mimetypes.guess_type(candidate.name)
        if candidate.suffix == ".js":
            content_type = "text/javascript"
        base_type = content_type or "application/octet-stream"
        if base_type.startswith("text/") or base_type in (
            "application/json", "application/javascript", "application/xml", "image/svg+xml",
        ):
            base_type = f"{base_type}; charset=utf-8"

        payload = candidate.read_bytes()
        stat = candidate.stat()
        etag = f'"{int(stat.st_mtime)}-{stat.st_size}"'

        headers = [
            ("Content-Type", base_type),
            ("Content-Length", str(len(payload))),
            ("Last-Modified", _http_date(stat.st_mtime)),
            ("ETag", etag),
            ("Cache-Control", "no-cache"),
            ("X-Content-Type-Options", "nosniff"),
        ]

        if_none_match = environ.get("HTTP_IF_NONE_MATCH")
        if if_none_match and if_none_match.strip() == etag:
            start_response("304 Not Modified", headers[:4])
            return [b""]

        start_response("200 OK", headers)
        return [b""] if method == "HEAD" else [payload]

    def _plain(self, start_response, status: int, message: str, method: str):
        body = message.encode("utf-8")
        start_response(self._status_line(status), [
            ("Content-Type", "text/plain; charset=utf-8"),
            ("Content-Length", str(len(body))),
        ])
        return [b""] if method == "HEAD" else [body]


def _http_date(timestamp: float) -> str:
    from email.utils import formatdate
    return formatdate(timestamp, usegmt=True)


def create_app(db_path: str | Path, root: str | Path, static: bool = True) -> Application:
    return Application(Database(db_path), Path(root), static=static)
