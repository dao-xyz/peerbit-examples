---
"@giga-app/app-service": patch
"@giga-app/sdk": patch
---

Authenticate Giga iframe messages by exact source and origin, validate their runtime schema, require rendered and original iframe URLs to share one normalized origin, remove stale listeners before source-change layout effects, restrict child-driven navigation to safe same-origin URLs, and grant each strictly resolved curated embed only its explicit iframe permissions or resizing capability.
