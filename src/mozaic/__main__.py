"""Command line: `mozaic serve` runs the app server, `mozaic mcp` runs the MCP server over stdio."""

from __future__ import annotations

import argparse
import logging

from . import config


def main() -> None:
    parser = argparse.ArgumentParser(prog="mozaic", description="Image studio for Qwen Image 2.1")
    sub = parser.add_subparsers(dest="cmd")
    serve = sub.add_parser("serve", help="Run the Mozaic server (UI, API and MCP over HTTP)")
    serve.add_argument("--port", type=int, default=config.DEFAULT_PORT)
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--idle-exit", type=float, default=0,
                       help="Shut down after this many idle seconds with no UI open (0 = never)")
    sub.add_parser("mcp", help="Run the MCP server over stdio (starts a headless Mozaic if needed)")
    args = parser.parse_args()

    if args.cmd == "mcp":
        from .mcp_server import run_stdio

        run_stdio()
        return

    import uvicorn

    from .server import create_app

    from .comfy import engine
    from .moss import moss_engine

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    port = getattr(args, "port", config.DEFAULT_PORT)
    app = create_app(idle_exit=getattr(args, "idle_exit", 0))
    app.state.port = port
    try:
        uvicorn.run(app, host=getattr(args, "host", "127.0.0.1"), port=port, log_level="warning",
                    timeout_graceful_shutdown=5)
    finally:
        engine.stop_sync()
        moss_engine.stop_sync()


if __name__ == "__main__":
    main()
