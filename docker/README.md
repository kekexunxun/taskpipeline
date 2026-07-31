# Managed Pi sandbox

Build with `docker build -t internal-coding-agent:dev docker/`.

The desktop app checks Docker availability before starting a task. When unavailable it surfaces host mode explicitly and relies on the Pi permission extension; it never silently claims the session is sandboxed.
