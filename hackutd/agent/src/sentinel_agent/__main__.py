"""`python -m sentinel_agent` starts the API on 127.0.0.1:8100."""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "sentinel_agent.main:create_app",
        factory=True,
        host=os.environ.get("AGENT_HOST", "127.0.0.1"),
        port=int(os.environ.get("AGENT_PORT", "8100")),
    )
