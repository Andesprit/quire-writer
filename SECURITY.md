# Security

Quire runs AI agents that can read and change files in the open project folder and use
other tools on your Mac. Problems in how it starts agents, asks for permissions, handles
files or installs updates can hurt people, so we treat them seriously.

## Report a problem

Do not open a public issue. Report it privately on GitHub:
[Report a vulnerability](https://github.com/Andesprit/quire-writer/security/advisories/new).

Please include what you found, how to reproduce it, the Quire version (Quire > About) and
your macOS version. We reply in the private report, and credit you in the release notes
unless you ask us not to.

## Supported versions

Only the latest release gets fixes. Quire updates itself, so most people run it.

## In scope

- Agent changes landing without the writer's review, or outside the open folder.
- Permission requests that can be skipped or tricked.
- Files read or written outside the open folder by the app itself.
- The update process: anything that could install an update not signed by this project.

Problems inside an agent (Claude, Codex, Gemini and others) belong to that agent's maker.
