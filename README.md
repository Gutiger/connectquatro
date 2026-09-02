# Connect4 Relay

Dependency-free WebSocket relay for two-player Connect Quatro rooms.

On Windows, use the launcher below. It finds either Node on `PATH` or the Node
runtime bundled with Codex, and does not require PowerShell script execution:

```powershell
.\relay\run-relay.cmd
```

Alternatively, run directly with Node.js 20 or newer:

```powershell
node .\relay\relay-server.mjs
```

The default endpoint is `ws://127.0.0.1:8080/connect4`. Override the bind address
and port with the `HOST` and `PORT` environment variables. For an internet
deployment, place the relay behind a TLS reverse proxy and set the game's
`global.c4_ws_host` to the resulting `wss://` origin.

Run the integration test:

```powershell
node .\relay\test-relay.mjs
```
