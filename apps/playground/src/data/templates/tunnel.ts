/** systemd unit that pipes in-VM :5173 out through the host relay (optional). */
export const TUNNEL_SERVICE_UNIT = `[Unit]
Description=WebSocket Tunnel Service
After=network.target

[Service]
Type=simple
ExecStart=tunnel --server ws://localhost:3005 --port 5173
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
