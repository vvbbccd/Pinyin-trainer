"""Dev-time helper: download the sources used to build the seed dictionary.

Downloads into .tmp/ (disposable). Run this only when you want to regenerate
data/words.json and data/chars.json.

Sources (all permissive):
  fxsjy/jieba dict.txt          Chinese word list + frequencies   (MIT)
  mozillazg/phrase-pinyin-data  phrase -> pinyin, polyphone-safe (MIT)
  mozillazg/pinyin-data         char   -> pinyin (Unihan based)  (MIT)
  OpenCC STCharacters           simplified -> traditional        (Apache-2.0)

The planned backend will use pypinyin directly instead of these static files.

Run:  python tools/fetch_data.py
"""
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".tmp")

TARGETS = {
    "jieba_dict.txt": "https://raw.githubusercontent.com/fxsjy/jieba/master/jieba/dict.txt",
    "phrase_pinyin.txt": "https://raw.githubusercontent.com/mozillazg/phrase-pinyin-data/master/large_pinyin.txt",
    "pinyin.txt": "https://raw.githubusercontent.com/mozillazg/pinyin-data/master/pinyin.txt",
    "STCharacters.txt": "https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/STCharacters.txt",
    # Taiwan/Hong Kong traditional forms (為, 裡) live in a SEPARATE dictionary:
    # STCharacters only carries the standard form (爲, 裏).
    "TWVariants.txt": "https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TWVariants.txt",
}


def main() -> int:
    os.makedirs(CACHE, exist_ok=True)
    failed = []
    for name, url in TARGETS.items():
        dest = os.path.join(CACHE, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            print(f"skip {name} ({os.path.getsize(dest):,} bytes already cached)")
            continue
        request = urllib.request.Request(url, headers={"User-Agent": "pinyin-trainer-dev/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                data = response.read()
            with open(dest, "wb") as handle:
                handle.write(data)
            print(f"ok   {name} -> {len(data):,} bytes")
        except Exception as error:  # noqa: BLE001
            failed.append(name)
            print(f"FAIL {name}: {error}")

    if failed:
        print(f"\n{len(failed)} download(s) failed: {', '.join(failed)}")
        return 1
    print(f"\nall sources cached in {CACHE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
