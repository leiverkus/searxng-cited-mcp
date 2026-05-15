# Contributing to dao-searxng-mcp

Thanks for your interest in contributing!

## Getting started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<your-user>/dao-searxng-mcp.git`
3. Install dependencies: `npm install`
4. Make sure you have a SearXNG instance running with JSON API enabled

## Development

```bash
# Run the server locally (connects via stdio)
node index.js

# Run tests
npm test
```

## Pull requests

- Keep PRs focused — one feature or fix per PR
- Add or update tests if you change behavior
- Update the README if you add new tools or environment variables
- Use clear commit messages

## Reporting issues

When reporting a bug, please include:

- Your Node.js version (`node --version`)
- Your SearXNG version
- The MCP client you're using (OpenCode, Claude Code, etc.)
- Steps to reproduce the issue

## Code style

- ES modules (`import`/`export`)
- No build step — the source is the distribution
- Keep dependencies minimal
