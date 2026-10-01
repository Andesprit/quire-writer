"""Self-check for change tracking. Run: uv run test_workspace.py"""

import asyncio
import tempfile
from pathlib import Path

from server import Workspace


async def main() -> None:
    root = Path(tempfile.mkdtemp()).resolve()
    (root / "main.typ").write_text("old")
    ws = Workspace()
    ws.root = root
    ws.known = {"main.typ": "old"}

    # The agent edits a file during turn 1 and creates another.
    ws.turn = 1
    (root / "main.typ").write_text("agent")
    await ws.external("main.typ", "agent")
    await ws.external("new.typ", "created")
    assert ws.baseline == {"main.typ": "old", "new.typ": ""}
    assert ws.checkpoints == {1: {"main.typ": "old", "new.typ": None}}

    # A save from a stale editor must not overwrite a newer disk version.
    (root / "main.typ").write_text("agent again")
    await ws.save("main.typ", "stale editor text", baseline="old")
    assert (root / "main.typ").read_text() == "agent again"

    # Accepting everything clears the baseline.
    await ws.save("main.typ", "agent again", baseline=None)
    assert "main.typ" not in ws.baseline

    # Restore puts files back to before turn 1 and removes created ones.
    (root / "new.typ").write_text("created")
    await ws.restore(1)
    assert (root / "main.typ").read_text() == "old"
    assert not (root / "new.typ").exists()
    assert ws.checkpoints == {}

    # Files and folders: create, rename (tracked changes follow), delete (to the Trash).
    import server
    trashed = []
    server.send2trash = trashed.append  # keep the real Trash out of the test
    await ws.create("notes/ch1.typ", folder=False)
    assert (root / "notes" / "ch1.typ").read_text() == ""
    await ws.create("figures", folder=True)
    assert (root / "figures").is_dir()
    ws.baseline["notes/ch1.typ"] = "old text"
    await ws.rename("notes", "chapters")
    assert (root / "chapters" / "ch1.typ").exists() and not (root / "notes").exists()
    assert ws.baseline == {"chapters/ch1.typ": "old text"}
    for bad in (lambda: ws.create("chapters/ch1.typ", False), lambda: ws.rename("chapters", "chapters/in"), lambda: ws.delete("")):
        try:
            await bad()
            raise AssertionError("should have been refused")
        except ValueError:
            pass
    await ws.delete("chapters")
    assert trashed == [str(root / "chapters")] and "chapters/ch1.typ" not in ws.baseline

    # A page still showing another folder cannot save into this one.
    server.ws_state = ws
    try:
        await server.handle({"type": "save", "root": "/some/other/folder", "path": "main.typ", "content": "x"})
        raise AssertionError("save for another folder was accepted")
    except ValueError:
        pass
    assert (root / "main.typ").read_text() == "old"

    # Paths outside the folder are refused.
    try:
        ws.path("../outside.typ")
        raise AssertionError("path escape not caught")
    except ValueError:
        pass

    # Labels: definitions, uses, and look-alikes in comments, raw text, math and e-mails.
    found = server.labels({
        "main.typ": "= Intro <intro>\nSee @fig:a. and #link(<intro>)[here].\n// <old> @gone\n$a<b>c$ `<raw>`\n#show <note>: none",
        "ch/a.typ": "#figure[x] <fig:a>\nmail me@site.org <unused>",
        "refs.bib": "<nope>",
    })
    assert [(f["name"], f["path"], f["line"], f["refs"]) for f in found] == [
        ("fig:a", "ch/a.typ", 0, 1), ("unused", "ch/a.typ", 1, 0), ("intro", "main.typ", 0, 1),
    ], found

    # Citations: DOI and arXiv forms, and keys made from the first author and year.
    assert server.doi_of(" https://doi.org/10.1038/nature14539 ") == "10.1038/nature14539"
    assert server.doi_of("arXiv:1706.03762v5") == server.doi_of("https://arxiv.org/abs/1706.03762") == "10.48550/arXiv.1706.03762"
    assert server.doi_of("hep-th/9901001") == "10.48550/arXiv.hep-th/9901001"
    try:
        server.doi_of("attention is all you need")
        raise AssertionError("not an id")
    except ValueError:
        pass
    entry = "@misc{https://doi.org/x, author = {Vaswani, Ashish and Shazeer, Noam}, year = {2017}}"
    assert server.cite_key(entry, set()) == "vaswani2017"
    assert server.cite_key(entry, {"vaswani2017"}) == "vaswani2017a"
    assert server.cite_key(r"@article{k, author={M{\"u}ller, J.}, year={2020}}", set()) == "muller2020"
    assert server.cite_key("@misc{k, title={No author}}", set()) == "ref"

    # A citation already in the .bib file is not fetched again.
    (root / "refs.bib").write_text("@article{lecun2015, title={Deep learning}, doi={10.1038/Nature14539}}\n")
    ws.known = {"main.typ": '#bibliography("refs.bib")'}
    assert await ws.cite("10.1038/nature14539") == {"key": "lecun2015", "bib": "refs.bib", "linked": True, "added": False}

    # Agent launch commands from the registry: npx first, a binary only for this machine.
    from agent import PLATFORM, launch, registry
    both = {"npx": {"package": "a@1", "args": ["--acp"]}, "uvx": {"package": "a"}}
    assert launch({"id": "a", "distribution": both}).argv == ["npx", "--prefer-offline", "-y", "a@1", "--acp"]
    assert launch({"id": "b", "distribution": {"binary": {PLATFORM: {"cmd": "./dist/b", "args": ["acp"]}}}}).argv == ["b", "acp"]
    assert launch({"id": "c", "distribution": {"binary": {"plan9-mips": {"cmd": "c"}}}}) is None
    assert "claude-acp" in registry()
    print("ok")


asyncio.run(main())
