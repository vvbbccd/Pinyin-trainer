"""REST API route handlers.

Every handler takes a :class:`Request` and returns ``(status, payload)`` where
payload is JSON-serialisable. Errors are raised as :class:`ApiError`.
"""

from __future__ import annotations

from typing import Any

from . import __version__
from .repository import Repository


class ApiError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code or _DEFAULT_CODES.get(status, "error")


_DEFAULT_CODES = {
    400: "bad_request",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    500: "internal_error",
}


def as_int(value, default: int, minimum: int | None = None, maximum: int | None = None) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    if minimum is not None:
        number = max(minimum, number)
    if maximum is not None:
        number = min(maximum, number)
    return number


def as_bool(value, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def as_list(value) -> list[str]:
    """Accepts "1,2" or ["1","2"] and returns a clean list of strings."""
    if value is None or value == "":
        return []
    if isinstance(value, (list, tuple)):
        items = [str(item).strip() for item in value]
    else:
        items = [piece.strip() for piece in str(value).split(",")]
    return [item for item in items if item]


class Api:
    """Wires HTTP routes to the repository."""

    def __init__(self, repo: Repository):
        self.repo = repo

    # ------------------------------------------------------------ routes --

    def routes(self) -> list[tuple[str, str, Any]]:
        return [
            ("GET", "/api/health", self.health),
            ("GET", "/api/meta", self.meta),

            ("GET", "/api/words", self.list_words),
            ("GET", "/api/words/random", self.random_words),
            ("GET", "/api/words/:id", self.get_word),

            ("POST", "/api/lookup", self.lookup),

            ("GET", "/api/sessions", self.list_sessions),
            ("POST", "/api/sessions", self.create_session),
            ("GET", "/api/sessions/:id", self.get_session),
            ("DELETE", "/api/sessions/:id", self.delete_session),

            ("GET", "/api/progress", self.get_progress),
            ("GET", "/api/progress/map", self.progress_map),
            ("GET", "/api/progress/words", self.progress_words),
            ("DELETE", "/api/progress", self.reset_progress),

            ("GET", "/api/library/saved", self.list_saved),
            ("POST", "/api/library/saved", self.add_saved),
            ("DELETE", "/api/library/saved", self.remove_saved),
            ("GET", "/api/library/history", self.list_history),
            ("POST", "/api/library/history", self.add_history),
            ("DELETE", "/api/library/history", self.clear_history),

            ("GET", "/api/settings", self.get_settings),
            ("PUT", "/api/settings", self.put_settings),

            ("GET", "/api/users/me", self.me),
        ]

    # ------------------------------------------------------- meta/health --

    def health(self, request):
        counts = self.repo.db.stats()
        return 200, {
            "status": "ok",
            "version": __version__,
            "database": str(self.repo.db.path),
            "lookupEngine": self.repo.engine.source_label(),
            "counts": counts,
        }

    def meta(self, request):
        return 200, self.repo.meta()

    def me(self, request):
        user = self.repo.get_user(request.user_id)
        if user is None:
            raise ApiError(404, "user not found")
        return 200, {
            "id": user["id"],
            "username": user["username"],
            "displayName": user["display_name"],
            "createdAt": user["created_at"],
            "progress": self.repo.progress_summary(request.user_id),
            "stats": self.repo.session_stats(request.user_id),
        }

    # ------------------------------------------------------------- words --

    def list_words(self, request):
        limit = as_int(request.query.get("limit"), 100, 1, 500)
        offset = as_int(request.query.get("offset"), 0, 0)
        words, total = self.repo.list_words(
            levels=[int(value) for value in as_list(request.query.get("levels")) if value.isdigit()],
            categories=as_list(request.query.get("categories")) or as_list(request.query.get("category")),
            search=request.query.get("search"),
            limit=limit,
            offset=offset,
        )
        return 200, {"words": words, "total": total, "limit": limit, "offset": offset}

    def random_words(self, request):
        count = as_int(request.query.get("count"), 20, 1, 300)
        words = self.repo.random_words(
            count=count,
            levels=[int(value) for value in as_list(request.query.get("levels")) if value.isdigit()],
            categories=as_list(request.query.get("categories")),
            focus_weak=as_bool(request.query.get("focusWeak"), True),
            user_id=request.user_id,
        )
        return 200, {"words": words, "count": len(words)}

    def get_word(self, request):
        word = self.repo.get_word(as_int(request.params.get("id"), 0))
        if word is None:
            raise ApiError(404, "word not found")
        return 200, {"word": word}

    # ------------------------------------------------------------ lookup --

    def lookup(self, request):
        body = request.json() or {}
        text = str(body.get("text") or body.get("query") or "").strip()
        if not text:
            raise ApiError(400, "text is required")
        if len(text) > 2000:
            raise ApiError(400, "text is too long (max 2000 characters)")

        result = self.repo.lookup(text)
        if as_bool(body.get("record"), True):
            self.repo.add_history(
                request.user_id, text,
                [{"text": seg["text"], "pinyin": seg["pinyin"], "source": seg["source"]}
                 for seg in result["segments"]],
            )
        result["query"] = text
        return 200, result

    # ---------------------------------------------------------- sessions --

    def list_sessions(self, request):
        limit = as_int(request.query.get("limit"), 50, 1, 200)
        offset = as_int(request.query.get("offset"), 0, 0)
        sessions = self.repo.list_sessions(request.user_id, limit=limit, offset=offset)
        return 200, {
            "sessions": sessions,
            "count": len(sessions),
            "stats": self.repo.session_stats(request.user_id),
        }

    def create_session(self, request):
        body = request.json() or {}
        try:
            session = self.repo.save_session(request.user_id, body)
        except ValueError as error:
            raise ApiError(400, str(error)) from error
        return 201, {"session": session}

    def get_session(self, request):
        session = self.repo.get_session(str(request.params.get("id")), request.user_id)
        if session is None:
            raise ApiError(404, "session not found")
        return 200, {"session": session}

    def delete_session(self, request):
        deleted = self.repo.delete_session(str(request.params.get("id")), request.user_id)
        if not deleted:
            raise ApiError(404, "session not found")
        return 200, {"deleted": True, "id": request.params.get("id")}

    # ---------------------------------------------------------- progress --

    def get_progress(self, request):
        limit = as_int(request.query.get("limit"), 20, 1, 200)
        return 200, {
            "summary": self.repo.progress_summary(request.user_id),
            "stats": self.repo.session_stats(request.user_id),
            "weakWords": self.repo.progress_words(request.user_id, "weak", limit),
            "strongWords": self.repo.progress_words(request.user_id, "mastered", min(limit, 20)),
        }

    def progress_map(self, request):
        """The whole progress table keyed by simplified form.

        Used to hydrate the browser client in one request instead of paging
        through /api/progress/words.
        """
        progress = self.repo.progress_map(request.user_id)
        return 200, {"progress": progress, "count": len(progress)}

    def progress_words(self, request):
        which = (request.query.get("filter") or "all").lower()
        if which not in ("all", "weak", "mastered"):
            raise ApiError(400, "filter must be one of: all, weak, mastered")
        limit = as_int(request.query.get("limit"), 50, 1, 5000)
        words = self.repo.progress_words(request.user_id, which, limit)
        return 200, {"words": words, "count": len(words), "filter": which}

    def reset_progress(self, request):
        removed = self.repo.reset_progress(request.user_id)
        return 200, {"deleted": removed}

    # ----------------------------------------------------------- library --

    def list_saved(self, request):
        words = self.repo.list_saved(request.user_id, as_int(request.query.get("limit"), 200, 1, 500))
        return 200, {"words": words, "count": len(words)}

    def add_saved(self, request):
        body = request.json() or {}
        simplified = str(body.get("simplified") or body.get("s") or "").strip()
        if not simplified:
            raise ApiError(400, "simplified is required")
        entry = self.repo.add_saved(
            request.user_id,
            simplified,
            str(body.get("pinyin") or body.get("p") or ""),
            body.get("traditional") or body.get("t"),
        )
        return 201, {"word": entry}

    def remove_saved(self, request):
        simplified = str(request.query.get("simplified") or "").strip()
        if not simplified:
            raise ApiError(400, "simplified is required")
        removed = self.repo.remove_saved(request.user_id, simplified, request.query.get("pinyin"))
        return 200, {"deleted": removed}

    def list_history(self, request):
        history = self.repo.list_history(request.user_id, as_int(request.query.get("limit"), 60, 1, 200))
        return 200, {"history": history, "count": len(history)}

    def add_history(self, request):
        body = request.json() or {}
        query = str(body.get("query") or "").strip()
        if not query:
            raise ApiError(400, "query is required")
        self.repo.add_history(request.user_id, query, body.get("results") or [])
        return 201, {"history": self.repo.list_history(request.user_id)}

    def clear_history(self, request):
        removed = self.repo.clear_history(request.user_id)
        return 200, {"deleted": removed}

    # ---------------------------------------------------------- settings --

    def get_settings(self, request):
        return 200, {"settings": self.repo.get_settings(request.user_id), "stored": True}

    def put_settings(self, request):
        body = request.json() or {}
        settings = body.get("settings") if "settings" in body else body
        if not isinstance(settings, dict):
            raise ApiError(400, "settings must be an object")
        return 200, {"settings": self.repo.put_settings(request.user_id, settings)}
