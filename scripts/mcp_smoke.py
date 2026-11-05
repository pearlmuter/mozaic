"""Smoke test for Mozaic's MCP server.

    uv run python scripts/mcp_smoke.py http            # HTTP endpoint of a running Mozaic
    uv run python scripts/mcp_smoke.py stdio           # `mozaic mcp` over stdio
    uv run python scripts/mcp_smoke.py http generate   # also make a small image (takes a few minutes)
"""

import asyncio
import json
import sys

from mcp import Client
from mcp.client.stdio import StdioServerParameters


async def main(transport: str, generate: bool) -> None:
    server = (
        "http://127.0.0.1:47811/mcp"
        if transport == "http"
        else StdioServerParameters(command=sys.executable, args=["-m", "mozaic", "mcp"])
    )
    async with Client(server, read_timeout_seconds=1200) as client:
        tools = await client.list_tools()
        print("tools:", ", ".join(t.name for t in tools.tools))
        guide = await client.read_resource("mozaic://guide")
        print("guide chars:", len(guide.contents[0].text))
        res = await client.call_tool("list_images", {"limit": 3})
        print("list_images:", res.content[0].text[:400])
        if generate:
            res = await client.call_tool(
                "generate_image",
                {"prompt": "A small watercolor fox, white background", "megapixels": 0.25, "steps": 12, "seed": 1},
            )
            print("generate_image:", res.content[0].text)
            print("content types:", [c.type for c in res.content])
            out = json.loads(res.content[0].text)
            assert out["status"] == "done", out


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "http", "generate" in sys.argv))
