### Added
- Proxy-only mode for a PC whose network allows only an HTTP proxy: started with
  `OVIS_OUTBOUND_PROXY_ONLY=1` and `HTTPS_PROXY=http://host:port`, the server sends every
  connection beyond the PC through that proxy (relay traffic whatever `NO_PROXY` says), never falls
  back to a direct one, and turns same Wi-Fi, Tailscale and SSH connections off. Settings → Ovis
  relay shows it and says why the relay is blocked when the proxy cannot be reached.

### Changed
- With `HTTPS_PROXY` set, relay and other WebSocket connections now use the proxy too, honouring
  `NO_PROXY`, as fetches already did.
