"""Reproduce the pinned Codex++ assets and complete bundled extensions.

Run from the repository root after cloning the pinned source into
.reference/CodexPlusPlus. Network catalog refresh is opt-in (--catalogs).
"""
import argparse
import collections
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import urllib.request

PIN = "75d25e0b8020a4a96cb4b75c00d75ee31ed2cc3c"
ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / ".reference/CodexPlusPlus"
TARGET = ROOT / "third_party/codexplusplus"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalogs", action="store_true")
    args = parser.parse_args()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=SOURCE, text=True).strip()
    if commit != PIN:
        raise SystemExit(f"Expected {PIN}, found {commit}; review before updating vendored source")
    TARGET.mkdir(parents=True, exist_ok=True)
    for relative in ("assets/inject", "assets/extensions"):
        shutil.copytree(SOURCE / relative, TARGET / relative, dirs_exist_ok=True)
    for relative in ("LICENSE", "THIRD_PARTY_NOTICES.md", "EXTENSIONS.md", "types/codex-plus-extensions.d.ts"):
        dest = TARGET / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SOURCE / relative, dest)
    # Preserve the source that defines assembly, runtime configuration and bridge contracts.
    source_files = ["bundled_extensions.rs", "assets.rs", "builtin_takeover.rs", "routes.rs", "plugin_market.rs", "plugin_marketplace.rs", "native_fast.rs", "native_predictions.rs"]
    for name in source_files:
        src = SOURCE / "crates/codex-plus-core/src" / name
        if src.is_file():
            dest = TARGET / "source" / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
    package_ids = ["agent-pet", "typing-effects", "image-overlay", "usage-statusline", "proxy-request-status"]
    for package in package_ids:
        shutil.copytree(SOURCE / "assets/extensions" / package, TARGET / "materialized/extensions" / package, dirs_exist_ok=True)
    pet = TARGET / "materialized/extensions/agent-pet"
    engine = (SOURCE / "assets/inject/upstream/whale-widget/full-widget-codex.js").read_text(encoding="utf-8")
    params = "window,document,fetch,localStorage,setTimeout,clearTimeout,setInterval,clearInterval,requestAnimationFrame,cancelAnimationFrame,MutationObserver,ResizeObserver,AudioContext,webkitAudioContext,Image,Audio"
    (pet / "whale-engine.js").write_text(f"  function codexPlusWhaleEngine({params}) {{\n{engine}\n  }}\n", encoding="utf-8")
    html = (pet / "settings.html").read_text(encoding="utf-8")
    scripts = (pet / "settings.js").read_text(encoding="utf-8") + "\n" + (pet / "settings-page.js").read_text(encoding="utf-8")
    (pet / "settings.html").write_text(html.replace("/*__AGENT_PET_SETTINGS_SCRIPTS__*/", scripts), encoding="utf-8")
    (pet / "assets/sounds").mkdir(parents=True, exist_ok=True)
    for name in ["Ya1.mp3", "Ya2.mp3", "D1.mp3", "D2.mp3"]:
        shutil.copy2(SOURCE / "assets/inject/agent-pet/sounds" / name, pet / "assets/sounds" / name)
    # The bundled widget's original art has a narrower license than its MIT code.
    for name in ("LICENSE", "PROVENANCE.md"):
        shutil.copy2(SOURCE / "assets/inject/upstream/whale-widget" / name, pet / ("WHALE-" + name))
    catalogs = {}
    if args.catalogs:
        proxy = urllib.request.ProxyHandler({"https": "http://127.0.0.1:10808"})
        opener = urllib.request.build_opener(proxy)
        for key, repo in [("public", "CodexPlusPlusPluginCache"), ("full", "CodexPlusPlusFullPluginCache")]:
            url = f"https://raw.githubusercontent.com/BigPizzaV3/{repo}/main/plugin-index.json"
            req = urllib.request.Request(url, headers={"User-Agent": "Aurora-source-vendor/0.6"})
            with opener.open(req, timeout=60) as response:
                data = response.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                raise ValueError("Catalog exceeds upstream size limit")
            parsed = json.loads(data)
            if parsed.get("schemaVersion") != 1 or not isinstance(parsed.get("plugins"), list):
                raise ValueError("Unsupported catalog schema")
            path = TARGET / "catalog" / (key + ".json")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            catalogs[key] = {"url": url, "sha256": hashlib.sha256(data).hexdigest(), "revision": parsed.get("revision"), "updatedAt": parsed.get("updatedAt"), "count": len(parsed["plugins"]), "licenses": dict(collections.Counter(str(x.get("license") or "unspecified") for x in parsed["plugins"])), "requiresAuth": sum(bool(x.get("requiresAuth")) for x in parsed["plugins"])}
    previous = TARGET / "UPSTREAM.json"
    if not catalogs and previous.exists():
        catalogs = json.loads(previous.read_text(encoding="utf-8")).get("catalogs", {})
    manifest = {"repository": "https://github.com/BigPizzaV3/CodexPlusPlus", "commit": PIN, "version": "pinned-source-2026-11-14", "license": "AGPL-3.0-only", "copyright": "BigPizzaV3 and CodexPlusPlus contributors", "modifications": ["Copied source assets unchanged", "Materialized bundled packages using upstream bundled_extensions.rs recipe", "Preserved third-party license and provenance notices", "Catalogs are metadata snapshots; third-party packages are installed on demand under their respective licenses"], "packages": package_ids, "catalogs": catalogs}
    write_json(previous, manifest)
    files = []
    for path in sorted(TARGET.rglob("*")):
        if path.is_file() and path.name != "FILES.sha256.json":
            data = path.read_bytes()
            files.append({"path": path.relative_to(TARGET).as_posix(), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    write_json(TARGET / "FILES.sha256.json", files)
    print(json.dumps({"files": len(files), "bytes": sum(x["bytes"] for x in files), "packages": package_ids, "catalogs": catalogs}, ensure_ascii=False))


if __name__ == "__main__":
    main()
