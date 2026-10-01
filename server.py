"""Local helper: serves the editor, talks to the agent, watches the folder.

Run: uv run server.py [folder]
"""

import asyncio
import contextlib
import json
import os
import re
import shutil
import socket
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from send2trash import send2trash
from starlette.applications import Starlette
from starlette.routing import Mount, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect
from watchfiles import awatch
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from agent import Bridge, registry

PORT = int(os.environ.get("PORT", "8765"))
ORIGINS = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
TEXT_EXT = {".typ", ".bib", ".yml", ".yaml", ".toml", ".md", ".txt", ".csv", ".json", ".xml", ".tex"}
MAX_FILE = 2_000_000
DEFAULT_AGENT = "claude-acp"

clients: set[WebSocket] = set()
tasks: set[asyncio.Task] = set()


async def send(msg: dict) -> None:
    for ws in list(clients):
        try:
            await ws.send_json(msg)
        except Exception:
            clients.discard(ws)


# Labels: <name> defines one; @name, ref(<name>), link(<name>) and show <name> use it.
LABEL = re.compile(r"(\(\s*|,\s*|show\s+)?<([\w:.-]+)>")
REF = re.compile(r"(?<![\w\\])@([\w-]+(?:[:.][\w-]+)*)")
# Comments, raw text and math, where <...> and @... mean something else.
HIDDEN = re.compile(r"/\*.*?\*/|```.*?```|`[^`\n]*`|(?<!\\)\$(?:[^$\\]|\\.)*\$|(?<!:)//[^\n]*", re.S)


def labels(texts: dict[str, str]) -> list[dict]:
    """Every label defined in the .typ files, and how many times it is used."""
    found, uses = [], Counter()
    for rel, text in sorted(texts.items()):
        if not rel.endswith(".typ"):
            continue
        text = HIDDEN.sub(lambda m: re.sub(r"[^\n]", " ", m[0]), text)  # keeps lines and columns
        for n, line in enumerate(text.split("\n")):
            uses.update(REF.findall(line))
            for m in LABEL.finditer(line):
                if m[1]:
                    uses[m[2]] += 1
                else:
                    found.append({"name": m[2], "path": rel, "line": n, "col": m.start()})
    return [{**f, "refs": uses[f["name"]]} for f in found]


# Citations. arXiv gives every paper a DOI, so both go through doi.org.
ARXIV = re.compile(r"(?:arxiv:\s*|https?://arxiv\.org/(?:abs|pdf)/)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?/\d{7})(?:v\d+)?(?:\.pdf)?", re.I)
BIB_KEY = re.compile(r"@\w+\s*\{\s*([^,\s]+)\s*,")


def doi_of(ident: str) -> str:
    s = ident.strip()
    if m := ARXIV.fullmatch(s):
        return f"10.48550/arXiv.{m[1]}"
    s = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", s, flags=re.I)
    if re.fullmatch(r"10\.\d{4,9}/\S+", s):
        return s
    raise ValueError(f"{ident.strip()} is not a DOI or an arXiv ID.")


def cite_key(entry: str, taken: set[str]) -> str:
    """A key like lecun2015. The registries' own keys can be whole URLs, which @ cannot use."""
    author = re.search(r"\bauthor\s*=\s*\{((?:[^{}]|\{[^{}]*\})*)\}", entry, re.I)
    first = author[1].split(" and ")[0] if author else ""
    last = first.split(",")[0] if "," in first else (first.split() or [""])[-1]
    last = unicodedata.normalize("NFKD", re.sub(r"\\.|[{}]", "", last))  # {\"u} and ü both become u
    year = re.search(r"\byear\s*=\s*\{?\s*(\d{4})", entry, re.I)
    base = (re.sub(r"[^a-z]", "", last.lower()) or "ref") + (year[1] if year else "")
    key, n = base, 0
    while key in taken:
        key, n = base + "abcdefghijklmnopqrstuvwxyz"[n], n + 1
    return key


def fetch_bibtex(doi: str) -> str:
    req = urllib.request.Request(
        f"https://doi.org/{urllib.parse.quote(doi)}", headers={"Accept": "application/x-bibtex; charset=utf-8"}
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read().decode()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise ValueError(f"No paper found for {doi}.") from None
        raise ValueError(f"doi.org answered {e.code} for {doi}.") from None
    except urllib.error.URLError as e:
        raise ValueError(f"Could not reach doi.org ({e.reason}). Check your internet connection.") from None


class Workspace:
    """The open folder. Every change made outside the editor (by the agent,
    or any other program) becomes a change the writer reviews."""

    def __init__(self) -> None:
        self.root: Path | None = None
        self.known: dict[str, str] = {}  # last content the editor and disk agreed on
        self.baseline: dict[str, str] = {}  # content before unreviewed changes
        self.turn = 0
        self.checkpoints: dict[int, dict[str, str | None]] = {}  # turn -> {path: content before it}
        self.watcher: asyncio.Task | None = None
        self.preview_proc: asyncio.subprocess.Process | None = None
        self.control: ClientConnection | None = None  # tinymist's editor connection
        self.preview_shown = False

    def path(self, rel: str) -> Path:
        p = (self.root / rel).resolve()
        if not p.is_relative_to(self.root):  # never read or write outside the folder
            raise ValueError(f"Path outside the project: {rel}")
        return p

    def is_text(self, p: Path) -> bool:
        rel = p.relative_to(self.root)
        return p.suffix in TEXT_EXT and not any(part.startswith(".") for part in rel.parts)

    def entries(self) -> tuple[list[str], list[str]]:
        """Every file and folder the explorer shows (hidden ones and node_modules left out)."""
        files, dirs = [], []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d != "node_modules")
            base = Path(dirpath).relative_to(self.root)
            dirs += [str(base / d) for d in dirnames]
            files += [str(base / f) for f in filenames if not f.startswith(".")]
        return sorted(files), sorted(dirs)

    def files(self) -> list[str]:
        """The text files whose changes are tracked."""
        return [f for f in self.entries()[0] if Path(f).suffix in TEXT_EXT]

    def rel(self, rel: str) -> str:
        """Normalize a path from the page, refusing the project folder itself."""
        p = self.path(rel)
        if p == self.root:
            raise ValueError("That is the project folder itself.")
        return str(p.relative_to(self.root))

    def forget(self, rel: str, to: str | None = None) -> None:
        """Move (or drop, when `to` is None) every tracked path at or under `rel`."""
        for d in (self.known, self.baseline, *self.checkpoints.values()):
            for k in [k for k in d if k == rel or k.startswith(rel + "/")]:
                v = d.pop(k)
                if to is not None:
                    d[to + k[len(rel):]] = v

    async def create(self, rel: str, folder: bool) -> None:
        rel = self.rel(rel)
        p = self.path(rel)
        if p.exists():
            raise ValueError(f"{rel} already exists.")
        if folder:
            p.mkdir(parents=True)
        else:
            p.parent.mkdir(parents=True, exist_ok=True)
            self.known[rel] = ""
            p.open("x").close()
        await send(self.state())
        if not folder and p.suffix in TEXT_EXT:
            await send({"type": "file", "path": rel, "content": "", "baseline": None})

    async def rename(self, old: str, new: str) -> None:
        old, new = self.rel(old), self.rel(new)
        src, dst = self.path(old), self.path(new)
        if not src.exists():
            raise ValueError(f"{old} does not exist.")
        if dst.exists():
            raise ValueError(f"{new} already exists.")
        if dst.is_relative_to(src):
            raise ValueError("A folder cannot be moved inside itself.")
        dst.parent.mkdir(parents=True, exist_ok=True)
        self.forget(old, new)
        src.rename(dst)
        await send({"type": "renamed", "from": old, "to": new})
        await send(self.state())

    async def delete(self, rel: str) -> None:
        rel = self.rel(rel)
        p = self.path(rel)
        if not p.exists():
            raise ValueError(f"{rel} does not exist.")
        send2trash(str(p))  # the Trash, not a permanent delete: the writer can get it back
        self.forget(rel)
        await send({"type": "deleted", "path": rel})
        await send(self.state())

    def read(self, rel: str) -> str | None:
        p = self.path(rel)
        try:
            if p.stat().st_size > MAX_FILE:
                return None
            return p.read_text()
        except (OSError, UnicodeDecodeError):
            return None

    async def open(self, root: str) -> None:
        self.root = Path(root).expanduser().resolve()
        if not self.root.is_dir():
            raise ValueError(f"Not a folder: {root}")
        self.known = {rel: c for rel in self.files() if (c := self.read(rel)) is not None}
        self.baseline, self.turn, self.checkpoints = {}, 0, {}
        if self.preview_proc and self.preview_proc.returncode is None:
            self.preview_proc.kill()  # it shows a file from the previous folder
        if self.watcher:
            self.watcher.cancel()
        self.watcher = spawn(self.watch())
        await send(self.state())
        await start_agent(bridge.agent_id or DEFAULT_AGENT)

    def state(self) -> dict:
        files, dirs = self.entries() if self.root else ([], [])
        return {
            "type": "folder",
            "root": str(self.root) if self.root else None,
            "files": files,
            "dirs": dirs,
            "changed": sorted(self.baseline),
            "labels": labels(self.known) if self.root else [],
        }

    async def save(self, rel: str, content: str, baseline: str | None) -> None:
        disk = self.read(rel)
        if disk is not None and disk != self.known.get(rel, disk):
            # Someone else wrote the file since we last looked: keep their
            # version and show it as a change instead of overwriting it.
            await self.external(rel, disk)
            return
        self.known[rel] = content
        self.path(rel).write_text(content)
        self.set_baseline(rel, content, baseline)
        await send({"type": "saved", "path": rel})

    def set_baseline(self, rel: str, content: str | None, baseline: str | None) -> None:
        if baseline is None or baseline == content:
            self.baseline.pop(rel, None)
        else:
            self.baseline[rel] = baseline

    async def external(self, rel: str, new: str) -> None:
        old = self.known.get(rel)
        if new == old:
            return
        self.known[rel] = new
        self.baseline.setdefault(rel, old or "")
        if self.turn:  # first change to this file in this turn: remember how it was
            self.checkpoints.setdefault(self.turn, {}).setdefault(rel, old)
        await send({"type": "file_changed", "path": rel, "content": new, "baseline": self.baseline[rel]})

    async def watch(self) -> None:
        async for changes in awatch(self.root, debounce=150, step=50):
            for _, raw in changes:
                p = Path(raw)
                if p.is_file() and self.is_text(p):
                    rel = str(p.relative_to(self.root))
                    if (new := self.read(rel)) is not None:
                        await self.external(rel, new)
            await send(self.state())

    async def restore(self, turn: int) -> None:
        """Put every file the agent touched back to how it was before `turn`."""
        before: dict[str, str | None] = {}
        for t in sorted((t for t in self.checkpoints if t >= turn), reverse=True):
            before.update(self.checkpoints.pop(t))  # earlier turns win
        for rel, old in before.items():
            self.baseline.pop(rel, None)
            if old is None:  # the agent created it
                self.known.pop(rel, None)
                self.path(rel).unlink(missing_ok=True)
            else:
                self.known[rel] = old
                self.path(rel).write_text(old)
            await send({"type": "file_changed", "path": rel, "content": old or "", "baseline": None, "deleted": old is None})
        await send(self.state())

    async def preview(self, rel: str) -> None:
        if self.preview_proc and self.preview_proc.returncode is None:
            self.preview_proc.kill()
        self.control, self.preview_shown = None, False
        if not shutil.which("tinymist"):
            raise RuntimeError("Live preview needs tinymist: brew install tinymist")
        port, data, control = free_port(), free_port(), free_port()
        # tinymist opens three servers, two on fixed default ports; give each its own free
        # port so two previews (two copies of the app) can run at once.
        self.preview_proc = await asyncio.create_subprocess_exec(
            "tinymist", "preview", str(self.path(rel)), "--root", str(self.root),
            "--host", f"127.0.0.1:{port}", "--data-plane-host", f"127.0.0.1:{data}",
            "--control-plane-host", f"127.0.0.1:{control}", "--no-open",
            # Redraw only the pages in view: long theses update far faster.
            "--partial-rendering", "true",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        for _ in range(50):  # wait until it listens
            try:
                _, w = await asyncio.open_connection("127.0.0.1", port)
                w.close()
                # The editor connection: clicks in the preview come in, "show this line" goes
                # out. tinymist takes one, and quits when it gets a ping, so pings are off.
                self.control = await connect(f"ws://127.0.0.1:{control}", ping_interval=None, max_size=None)
                break
            except OSError:
                await asyncio.sleep(0.1)
        if self.control:
            spawn(self.follow(self.control))
        await send({"type": "preview", "path": rel, "url": f"http://127.0.0.1:{port}"})

    async def follow(self, control: ClientConnection) -> None:
        """A click in the preview: show that place in the editor."""
        with contextlib.suppress(ConnectionClosed):  # the preview was closed or replaced
            async for raw in control:
                msg = json.loads(raw)
                if msg.get("event") == "outline" and control is self.control:
                    self.preview_shown = True  # tinymist sends the outline once the page has drawn
                if msg.get("event") != "editorScrollTo" or not msg.get("start"):
                    continue
                p = Path(msg["filepath"]).resolve()
                if p.is_relative_to(self.root):  # not text inside a package
                    line, col = msg["start"]
                    await send({"type": "jump", "path": str(p.relative_to(self.root)), "line": line, "col": col})

    async def scroll_preview(self, rel: str, line: int, col: int) -> None:
        # Only once the preview has drawn: before that tinymist has nothing to scroll, and in
        # testing a scroll during loading once left the preview blank.
        if self.control and self.preview_shown:
            with contextlib.suppress(ConnectionClosed):
                await self.control.send(json.dumps({"event": "panelScrollTo", "filepath": str(self.path(rel)), "line": line, "character": col}))

    def bib_file(self) -> tuple[str, bool]:
        """The .bib file new citations go to, and whether a #bibliography(...) uses it."""
        for rel, text in sorted(self.known.items()):
            if rel.endswith(".typ") and (m := re.search(r'bibliography\(\s*\(?\s*"([^"]+\.bib)"', text)):
                name = m[1][1:] if m[1].startswith("/") else os.path.normpath(Path(rel).parent / m[1])
                return self.rel(name), True
        return next((f for f in self.files() if f.endswith(".bib")), "refs.bib"), False

    async def cite(self, ident: str) -> dict:
        """Add the paper for a DOI or arXiv ID to the .bib file. Returns its key."""
        doi = doi_of(ident)
        rel, linked = self.bib_file()
        p = self.path(rel)
        text = p.read_text() if p.exists() else ""
        # Already there: reuse its key.
        if dup := re.search(r"\bdoi\s*=\s*[{\"]\s*" + re.escape(doi) + r"\s*[}\"]", text, re.I):
            keys = BIB_KEY.findall(text[: dup.start()])
            if keys:
                return {"key": keys[-1], "bib": rel, "linked": linked, "added": False}
        entry = (await asyncio.to_thread(fetch_bibtex, doi)).strip()
        if not (m := BIB_KEY.match(entry)):
            raise ValueError(f"doi.org has no BibTeX for {doi}.")
        key = cite_key(entry, set(BIB_KEY.findall(text)))
        entry = entry[: m.start(1)] + key + entry[m.end(1) :]
        new = (text.rstrip() + "\n\n" if text.strip() else "") + entry + "\n"
        tracked = rel in self.known or not p.exists()
        if tracked:
            self.known[rel] = new  # the writer asked for it: not a change to review
        p.write_text(new)
        if tracked:
            await send({"type": "file_changed", "path": rel, "content": new, "baseline": self.baseline.get(rel)})
        return {"key": key, "bib": rel, "linked": linked, "added": True}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


bridge = Bridge(send)
ws_state = Workspace()


async def start_agent(agent_id: str) -> None:
    if ws_state.root is None:  # no folder yet: remember the choice, start on open
        bridge.agent_id = agent_id
        await send({"type": "agent", "id": agent_id, "ready": False})
        return
    await send({"type": "status", "text": f"Starting {registry()[agent_id].name}..."})
    await bridge.start(agent_id, ws_state.root)
    await send({"type": "agent", "id": agent_id, "ready": True})


def spawn(coro) -> asyncio.Task:
    t = asyncio.create_task(coro)
    tasks.add(t)
    t.add_done_callback(tasks.discard)
    return t


async def pick_folder() -> str | None:
    proc = await asyncio.create_subprocess_exec(
        "osascript", "-e", 'POSIX path of (choose folder with prompt "Open a Typst project")',
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    return out.decode().strip() or None


async def chat(text: str, path: str | None, selection: str | None) -> None:
    ws_state.turn += 1
    turn = ws_state.turn
    context = f"\n\n(The writer has {path} open.)" if path else ""
    if selection:
        context += f"\n\nSelected text:\n{selection}"
    await send({"type": "turn_start", "turn": turn, "text": text})
    try:
        stop, _ = await bridge.prompt("chat", text + context)
    except Exception as e:
        stop = "error"
        await send({"type": "error", "message": str(e)})
    await send({"type": "turn_end", "turn": turn, "stop": stop})


# Messages that read or write files. Each carries the folder the page is showing, so a
# page (or a second tab) still showing another folder can never write into this one.
FILE_OPS = {"open_file", "save", "review", "create", "rename", "delete", "preview", "restore", "cite"}


async def handle(msg: dict) -> None:
    t = msg["type"]
    if t in FILE_OPS and (ws_state.root is None or msg.get("root") != str(ws_state.root)):
        raise ValueError("This page was showing a different folder, so nothing was changed. Reload the page.")
    if t == "open_folder":
        if path := msg.get("path") or await pick_folder():
            await ws_state.open(path)
    elif t == "open_file":
        rel = msg["path"]
        if Path(rel).suffix not in TEXT_EXT:
            raise ValueError(f"{Path(rel).name} is not a text file, so it cannot be opened here.")
        content = ws_state.read(rel)
        if content is None:
            raise ValueError(f"Cannot open {rel}")
        await send({"type": "file", "path": rel, "content": content, "baseline": ws_state.baseline.get(rel)})
    elif t == "save":
        await ws_state.save(msg["path"], msg["content"], msg.get("baseline"))
    elif t == "review":
        # Review decisions (accept/reject) while the text itself is not saved yet.
        ws_state.set_baseline(ws_state.rel(msg["path"]), None, msg.get("baseline"))
    elif t == "create":
        await ws_state.create(msg["path"], msg.get("folder", False))
    elif t == "rename":
        await ws_state.rename(msg["from"], msg["to"])
    elif t == "delete":
        await ws_state.delete(msg["path"])
    elif t == "preview":
        await ws_state.preview(msg["path"])
    elif t == "scroll_preview":
        await ws_state.scroll_preview(msg["path"], msg["line"], msg["col"])
    elif t == "cite":
        await send({"type": "cite_result", "req": msg["req"], **await ws_state.cite(msg["id"])})
    elif t == "prompt":
        await chat(msg["text"], msg.get("path"), msg.get("selection"))
    elif t == "cancel":
        await bridge.cancel("chat")
    elif t == "permission":
        bridge.answer_permission(msg["id"], msg.get("option"))
    elif t == "set_agent":
        await start_agent(msg["id"])
    elif t == "set_option":
        await bridge.set_option(msg["kind"], msg["id"], msg["value"])
    elif t == "inline":
        text = await bridge.inline(msg["path"], msg["instruction"], msg["selected"], msg["before"], msg["after"])
        await send({"type": "inline_result", "req": msg["req"], "text": text})
    elif t == "complete":
        text = await bridge.complete(msg["before"], msg["after"])
        await send({"type": "complete_result", "req": msg["req"], "text": text})
    elif t == "warm":
        if bridge.conn:  # no agent yet: it warms up when the agent starts
            await bridge.session(msg["kind"])
    elif t == "restore":
        await ws_state.restore(msg["turn"])


async def safe(msg: dict) -> None:
    try:
        await handle(msg)
    except Exception as e:
        await send({"type": "error", "message": f"{msg.get('type')}: {e}", "req": msg.get("req"), "op": msg.get("type")})


@asynccontextmanager
async def lifespan(app: Starlette):
    if len(sys.argv) > 1:
        spawn(safe({"type": "open_folder", "path": sys.argv[1]}))
    yield
    await bridge.stop()
    if ws_state.preview_proc and ws_state.preview_proc.returncode is None:
        ws_state.preview_proc.kill()


async def websocket(ws: WebSocket) -> None:
    # Any web page can open a socket to localhost; only our own page may drive the agent.
    if ws.headers.get("origin") not in ORIGINS:
        await ws.close(code=1008)
        return
    await ws.accept()
    clients.add(ws)
    agents = sorted(({"id": s.id, "name": s.name} for s in registry().values()), key=lambda a: a["name"].lower())
    await ws.send_json({"type": "hello", "agents": agents, "agent": bridge.agent_id or DEFAULT_AGENT})
    await ws.send_json(ws_state.state())
    for kind, options in bridge.options.items():
        await ws.send_json({"type": "options", "kind": kind, "options": options})
    try:
        while True:
            msg = await ws.receive_json()
            if msg["type"] in ("save", "review"):
                await safe(msg)  # in order, so an older save never lands after a newer one
            else:
                spawn(safe(msg))
    except WebSocketDisconnect:
        clients.discard(ws)


app = Starlette(
    lifespan=lifespan,
    routes=[
        WebSocketRoute("/ws", websocket),
        Mount("/", StaticFiles(directory=Path(__file__).parent / "web" / "dist", html=True), name="web"),
    ],
)

if __name__ == "__main__":
    url = f"http://127.0.0.1:{PORT}"
    # Check the port before starting anything: otherwise the agent starts, then the server
    # fails to bind, and an older copy keeps running unnoticed.
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", PORT)) == 0:
            sys.exit(
                f"Port {PORT} is busy: Typst Writer (or another program) is already running at {url}.\n"
                "Stop it with Ctrl+C in its terminal, then start again. Or use another port: PORT=8766 uv run server.py"
            )
    print(f"Typst Writer on {url}")
    if not os.environ.get("NO_BROWSER"):
        webbrowser.open(url)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
