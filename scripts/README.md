# Open the OpenHAB folder together with this MCP in VS Code

Use these helper scripts to open VS Code with your OpenHAB folder plus the local MCP repository as a multi-root workspace. This avoids writing workspace files to the OpenHAB network share.

Usage (Linux/macOS):

```bash
# from any location
/home/des/Documents/oh-mcp/scripts/open-with-mcp.sh /path/to/openhab

# or set MCP_PATH to override where the MCP repo is located
MCP_PATH=/home/des/Documents/oh-mcp /usr/local/bin/open-with-mcp.sh /path/to/openhab
```

Usage (Windows):

```powershell
# from any location
C:\path\to\oh-mcp\scripts\open-with-mcp.bat C:\path\to\openhab

# or set MCP_PATH environment variable to override
set MCP_PATH=C:\path\to\oh-mcp
open-with-mcp.bat C:\path\to\openhab
```

Notes:
- The scripts use the `code` CLI. If `code` is not available, enable it from VS Code (Command Palette → "Shell Command: Install 'code' command in PATH").
- You can place the script in your PATH (e.g., `/usr/local/bin`) or create shortcuts/desktop entries that run the script.
- The scripts default to assuming they live inside the MCP repo under `scripts/`. If you relocate them, set the `MCP_PATH` environment variable.
