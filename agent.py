"""ACP bridge: one agent process with up to three sessions.

- chat:     the chat bar. Its updates stream to the browser as-is.
- inline:   select-and-edit. Replies with replacement text only.
- complete: autocomplete. Replies with the next few words only.

Agents are started from agents.json, a copy of the ACP registry, so any
agent listed there (Claude, Codex, Gemini, ...) works by id.
"""

import asyncio
import contextlib
import json
import os
import platform
import sys
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, NamedTuple

import acp
from acp.schema import (
    AgentMessageChunk,
    AllowedOutcome,
    ClientCapabilities,
    ConfigOptionUpdate,
    DeniedOutcome,
    RequestPermissionResponse,
    TextContentBlock,
)
Send = Callable[[dict], Awaitable[None]]

AGENTS = Path(__file__).with_name("agents.json")
ARCH = {"arm64": "aarch64", "amd64": "x86_64"}.get(platform.machine().lower(), platform.machine().lower())
PLATFORM = f"{sys.platform}-{ARCH}"  # the registry's name for this machine, e.g. darwin-aarch64

EFFORT_IDS = {"effort", "reasoning_effort", "thought_level"}
FAST_MODEL_HINTS = ("haiku", "mini", "flash", "fast", "small")
LOW_EFFORT = ("minimal", "none", "off", "low")

INLINE_PROMPT = """You are editing a Typst document ({path}). Rewrite the SELECTED text following the instruction.
Reply with ONLY the replacement text. No explanation, no quotes, no code fences. Do not use any tools.
If nothing is selected, reply with the text to insert at the cursor.

Instruction: {instruction}

Text before the selection:
{before}

SELECTED:
{selected}

Text after the selection:
{after}"""

COMPLETE_PROMPT = """You are the autocomplete of a Typst editor. Continue the text at <CURSOR>.
Reply with ONLY the text to insert: a few words, at most one sentence. Start with a space if one is needed.
No explanation, no quotes, no code fences. Do not use any tools.

{before}<CURSOR>{after}"""


def dump(model: Any) -> Any:
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)


class Agent(NamedTuple):
    id: str
    name: str
    argv: list[str]
    env: dict[str, str]


def launch(entry: dict) -> Agent | None:
    """How to start a registry agent here. npx and uvx fetch the agent on first use; a
    binary is never downloaded, so it must already be on PATH under its own name."""
    d = entry.get("distribution") or {}
    if pkg := (d.get("npx") or {}).get("package"):
        # --prefer-offline: a pinned version in the npx cache starts without asking npm.
        e, argv = d["npx"], ["npx", "--prefer-offline", "-y", pkg]
    elif pkg := (d.get("uvx") or {}).get("package"):
        e, argv = d["uvx"], ["uvx", pkg]
    elif e := (d.get("binary") or {}).get(PLATFORM):
        argv = [e.get("cmd", "").rsplit("/", 1)[-1]]
    else:
        return None
    return Agent(entry["id"], entry.get("name", entry["id"]), argv + e.get("args", []), e.get("env") or {})


def registry() -> dict[str, Agent]:
    # `atelier harness sync` (flow-atelier) writes a fresher copy here; use it when present.
    try:
        raw = json.loads((Path.home() / ".atelier" / "acp_registry.json").read_text())
    except (OSError, ValueError):
        raw = json.loads(AGENTS.read_text())
    return {a["id"]: spec for a in raw.get("agents", []) if (spec := launch(a))}


def select_values(option: dict) -> list[str]:
    values = []
    for entry in option.get("options", []):
        if "options" in entry:  # grouped select
            values += [o["value"] for o in entry["options"]]
        else:
            values.append(entry["value"])
    return values


def is_model(option: dict) -> bool:
    return option.get("category") == "model" or option.get("id") == "model"


def is_effort(option: dict) -> bool:
    return option.get("category") == "thought_level" or option.get("id") in EFFORT_IDS


class Bridge:
    def __init__(self, send: Send):
        self.send = send
        self.stack: contextlib.AsyncExitStack | None = None
        self.conn: Any = None
        self.agent_id: str | None = None
        self.root: Path | None = None
        self.sessions: dict[str, str] = {}  # kind -> session id
        self.options: dict[str, list[dict]] = {}  # kind -> config options
        self.chosen: dict[str, dict[str, Any]] = {}  # kind -> user picks, re-applied to new sessions
        self.replies: dict[str, list[str]] = {}  # session id -> text chunks
        self.pending: dict[str, asyncio.Future] = {}  # permission id -> future
        self.complete_lock = asyncio.Lock()
        self.session_lock = asyncio.Lock()
        self.completions = 0

    def kind_of(self, session_id: str) -> str | None:
        return next((k for k, s in self.sessions.items() if s == session_id), None)

    async def start(self, agent_id: str, root: Path) -> None:
        spec = registry()[agent_id]
        await self.stop()
        self.root = root  # set first: nothing may start a session in the previous folder
        self.stack = contextlib.AsyncExitStack()
        conn, _ = await self.stack.enter_async_context(
            acp.spawn_agent_process(
                self,
                *spec.argv,
                env={**os.environ, **spec.env},
                cwd=str(root),
                # stderr=None: agent logs go to the server's terminal.
                transport_kwargs={"limit": 8 * 1024 * 1024, "stderr": None},
            )
        )
        await conn.initialize(
            protocol_version=acp.PROTOCOL_VERSION,
            client_capabilities=ClientCapabilities(),
        )
        if agent_id != self.agent_id:
            self.chosen = {}
        self.agent_id = agent_id
        self.conn = conn  # usable only now, once it knows its folder and has started
        await self.session("chat")

    async def stop(self) -> None:
        self.resolve_permissions(None)
        if self.stack:
            with contextlib.suppress(Exception):
                await self.stack.aclose()
        self.stack, self.conn, self.sessions, self.options = None, None, {}, {}

    async def session(self, kind: str) -> str:
        async with self.session_lock:  # two requests must not open two sessions of one kind
            return await self._session(kind)

    async def _session(self, kind: str) -> str:
        if kind in self.sessions:
            return self.sessions[kind]
        if self.conn is None or self.root is None:
            raise RuntimeError("No agent running. Open a folder first.")
        s = await self.conn.new_session(cwd=str(self.root), mcp_servers=[])
        self.sessions[kind] = s.session_id
        self.options[kind] = [dump(o) for o in (s.config_options or [])]
        for config_id, value in self.picks_for(kind).items():
            await self.apply_option(kind, config_id, value)
        if kind == "complete" and not self.chosen.get("complete"):
            # Effort choices depend on the model, so pick the model first.
            for model in (True, False):
                for config_id, value in self.fast_picks(model).items():
                    await self.apply_option(kind, config_id, value)
        await self.send({"type": "options", "kind": kind, "options": self.options[kind]})
        return self.sessions[kind]

    def picks_for(self, kind: str) -> dict[str, Any]:
        if kind != "inline":
            return self.chosen.get(kind, {})
        # Inline edits follow the chat model and effort, never its mode (a
        # permissive mode would let the inline session edit files).
        shared = {o["id"] for o in self.options.get("chat", []) if is_model(o) or is_effort(o)}
        return {k: v for k, v in self.chosen.get("chat", {}).items() if k in shared}

    def fast_picks(self, model: bool) -> dict[str, str]:
        """Smallest model (model=True) or lowest effort the complete session offers."""
        picks = {}
        for o in self.options.get("complete", []):
            if o.get("type") != "select":
                continue
            values = select_values(o)
            if model and is_model(o):
                hints, match = FAST_MODEL_HINTS, lambda h, v: h in v.lower()
            elif not model and is_effort(o):
                hints, match = LOW_EFFORT, lambda h, v: h == v.lower()
            else:
                continue
            found = next((v for h in hints for v in values if match(h, v)), None)
            if found:
                picks[o["id"]] = found
        return picks

    async def apply_option(self, kind: str, config_id: str, value: Any) -> None:
        r = await self.conn.set_config_option(
            config_id=config_id, session_id=self.sessions[kind], value=value
        )
        if r and r.config_options is not None:
            self.options[kind] = [dump(o) for o in r.config_options]

    async def set_option(self, kind: str, config_id: str, value: Any) -> None:
        await self.session(kind)
        self.chosen.setdefault(kind, {})[config_id] = value
        await self.apply_option(kind, config_id, value)
        await self.send({"type": "options", "kind": kind, "options": self.options[kind]})
        if kind == "chat" and "inline" in self.sessions and config_id in self.picks_for("inline"):
            await self.apply_option("inline", config_id, value)

    async def prompt(self, kind: str, text: str) -> tuple[str, str]:
        sid = await self.session(kind)
        self.replies[sid] = []
        r = await self.conn.prompt(session_id=sid, prompt=[TextContentBlock(type="text", text=text)])
        return r.stop_reason, "".join(self.replies.pop(sid, []))

    async def cancel(self, kind: str) -> None:
        if kind == "chat":
            self.resolve_permissions(None)
        if self.conn and kind in self.sessions:
            await self.conn.cancel(session_id=self.sessions[kind])

    async def inline(self, path: str, instruction: str, selected: str, before: str, after: str) -> str:
        text = INLINE_PROMPT.format(
            path=path, instruction=instruction, selected=selected, before=before, after=after
        )
        _, reply = await self.prompt("inline", text)
        return strip_fences(reply)

    async def complete(self, before: str, after: str) -> str:
        if self.complete_lock.locked():  # a newer keystroke wins
            await self.cancel("complete")
        async with self.complete_lock:
            self.completions += 1
            # ponytail: every completion adds to the session history; start a fresh
            # session every 20 so it stays small. Smarter: agent-side NES when agents ship it.
            if self.completions % 20 == 0:
                self.sessions.pop("complete", None)
            _, reply = await self.prompt("complete", COMPLETE_PROMPT.format(before=before, after=after))
            reply = strip_fences(reply).rstrip("\n")
            # A suggestion is one short line. Anything else is chatter or an error message.
            return "" if "\n" in reply or len(reply) > 300 else reply

    def resolve_permissions(self, option_id: str | None) -> None:
        for fut in self.pending.values():
            if not fut.done():
                fut.set_result(option_id)

    def answer_permission(self, pid: str, option_id: str | None) -> None:
        fut = self.pending.get(pid)
        if fut and not fut.done():
            fut.set_result(option_id)

    # --- ACP Client methods (called by the agent) ---

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        kind = self.kind_of(session_id)
        if isinstance(update, ConfigOptionUpdate) and kind:
            self.options[kind] = [dump(o) for o in update.config_options]
            await self.send({"type": "options", "kind": kind, "options": self.options[kind]})
        elif kind == "chat":
            await self.send({"type": "update", "update": dump(update)})
        elif isinstance(update, AgentMessageChunk) and update.content.type == "text":
            self.replies.setdefault(session_id, []).append(update.content.text)

    async def request_permission(self, session_id: str, tool_call: Any, options: list, **kwargs: Any):
        if self.kind_of(session_id) != "chat":
            # inline/complete must only reply with text: refuse every tool.
            reject = next((o for o in options if o.kind.startswith("reject")), None)
            if reject:
                return RequestPermissionResponse(outcome=AllowedOutcome(outcome="selected", option_id=reject.option_id))
            return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))
        pid = uuid.uuid4().hex
        self.pending[pid] = asyncio.get_running_loop().create_future()
        await self.send(
            {"type": "permission", "id": pid, "toolCall": dump(tool_call), "options": [dump(o) for o in options]}
        )
        try:
            option_id = await self.pending[pid]
        finally:
            self.pending.pop(pid, None)
        if option_id is None:
            return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))
        return RequestPermissionResponse(outcome=AllowedOutcome(outcome="selected", option_id=option_id))

    def on_connect(self, conn: Any) -> None:
        pass


def strip_fences(text: str) -> str:
    t = text.strip("\n")
    if t.startswith("```") and t.endswith("```"):
        t = t.split("\n", 1)[1].rsplit("```", 1)[0].rstrip("\n") if "\n" in t else t.strip("`")
    return t
