"""Chinese Pinyin Typing Trainer — backend.

``python -m server`` serves the REST API and the browser client from one process.
No third-party dependencies: http.server + sqlite3 from the standard library,
with pypinyin used automatically if it happens to be installed.
"""

__version__ = "1.0.0"

__all__ = ["__version__"]
