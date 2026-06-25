# Security Policy

## Reporting a vulnerability
Please report security issues privately to **dev.lakhani1@gmail.com** rather than
opening a public issue. Include steps to reproduce and the affected version
(shown in the overlay panel footer). You'll get a response as soon as possible.

## Scope notes
- The extension runs as a content script on `pokernow.club` / `pokernow.com`.
- It stores opponent statistics locally in IndexedDB; no data is sent to any
  server. There is no telemetry or remote endpoint.
- Debug logging is gated behind a leveled logger and off by default.
