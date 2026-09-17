"""Entry point: ``python -m server [--host H] [--port P] [--db PATH]``."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server
from socketserver import ThreadingMixIn

from . import __version__
from .db import Database
from .http_app import Application

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "var" / "trainer.db"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000


class ThreadingWSGIServer(ThreadingMixIn, WSGIServer):
    """Threaded so a slow lookup never blocks another request."""

    daemon_threads = True
    allow_reuse_address = True


class QuietHandler(WSGIRequestHandler):
    """Log one tidy line per request instead of the raw WSGI dump."""

    def log_message(self, fmt: str, *args) -> None:  # noqa: A002
        sys.stderr.write(f"  {self.address_string()} {fmt % args}\n")

    def log_error(self, fmt: str, *args) -> None:  # noqa: A002
        self.log_message(fmt, *args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m server",
        description="Serve the pinyin trainer API and web client.",
    )
    parser.add_argument("--host", default=os.environ.get("TRAINER_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("TRAINER_PORT", DEFAULT_PORT)))
    parser.add_argument("--db", default=os.environ.get("TRAINER_DB", str(DEFAULT_DB)),
                        help="path to the SQLite database (default: var/trainer.db)")
    parser.add_argument("--root", default=str(ROOT), help="directory holding index.html and assets/")
    parser.add_argument("--no-static", action="store_true", help="serve the API only")
    parser.add_argument("--version", action="version", version=f"pinyin-trainer {__version__}")
    return parser


def create_server(host: str, port: int, db_path: str | Path, root: str | Path, static: bool = True):
    """Build the WSGI server. Also used by the tests with port=0 (random port)."""
    db = Database(db_path)
    db.init_schema()
    app = Application(db, Path(root), static=static)
    return make_server(host, port, app, server_class=ThreadingWSGIServer, handler_class=QuietHandler)


def _safe_console() -> None:
    """Never let console output kill the process.

    Windows terminals are frequently a legacy CJK codepage (cp950, cp936, …)
    that cannot encode simplified Chinese, so printing the banner would raise
    UnicodeEncodeError. Reconfiguring to UTF-8 with replacement characters keeps
    the server running everywhere.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def main(argv: list[str] | None = None) -> int:
    _safe_console()
    args = build_parser().parse_args(argv)
    db_path = Path(args.db)

    if not db_path.exists():
        print(f"! database not found at {db_path}")
        print("  build it first:  python tools/build_database.py")
        print("  (continuing with an empty schema)")

    try:
        server = create_server(args.host, args.port, db_path, args.root, static=not args.no_static)
    except OSError as error:
        if "in use" in str(error).lower() or getattr(error, "errno", None) in (48, 98, 10048):
            print(f"! port {args.port} is already in use; try --port {args.port + 1}")
            return 1
        raise

    host, port = server.server_address[:2]
    app: Application = server.get_app()  # type: ignore[attr-defined]
    counts = app.db.stats()

    print(f"拼音练习场 · Pinyin Trainer backend {__version__}")
    print(f"  listening   http://{host}:{port}/")
    print(f"  api base    http://{host}:{port}/api")
    print(f"  database    {db_path}")
    print(f"  lookup      {app.repo.engine.source_label()}"
          f"{'' if app.repo.engine.has_phrase_data() else '  (no phrase data: run tools/fetch_data.py)'}")
    print(f"  words       {counts.get('chinese_words', 0):,}"
          f"   phrases {counts.get('phrase_pinyin', 0):,}"
          f"   characters {counts.get('char_pinyin', 0):,}")
    print("  Ctrl+C to stop\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping…")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
