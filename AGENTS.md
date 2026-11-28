# Working on Raft Lark Bridge

Start with [the project README](README.md) and [documentation index](docs/README.md).

- For installation or configuration, follow the [project Skill](skills/raft-lark-bridge/SKILL.md). Identify whether the user wants the current text bridge or the planned cloud question-card service, then check the target host and platform capabilities.
- For source changes, use a feature branch off `main` and follow [the contribution guide](CONTRIBUTING.md). Read the feature's spec and acceptance cases before editing. Ask a maintainer for review with the exact commit and verification results.
- Use CodeGraph to locate definitions, callers and dependencies. Confirm the relevant source and exact strings in the checkout. Keep the index local and enable the repository's pre-push hook on development checkouts.
- Use test accounts and synthetic fixtures for automated checks. Keep credentials, local bridge state and private conversation contents out of Git. Only run real setup, registration or messaging within the user's requested scope.
