# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

## Bug Fixes

- **GitHub-built Electron packages include the Pi subprocess** — The documented packaging scripts now stage the built `session-mcp-server` and `pi-agent-server` bundles into `apps/electron/resources/` before resource copying, including the target platform's `koffi` native module for Pi SDK sessions. This fixes GitHub Actions artifacts failing at runtime with `piServerPath not configured. Cannot spawn Pi subprocess.`

## Breaking Changes
