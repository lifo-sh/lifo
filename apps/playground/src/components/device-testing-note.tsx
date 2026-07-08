interface DeviceTestingNoteProps {
  /** The in-VM Metro port this example runs on (8081 expo, 8082 expo-router). */
  port: number;
}

/**
 * Collapsible runbook for testing an Expo example on a physical phone via Expo
 * Go, tunneled out of the browser VM. Shown under the Expo example subtitles.
 * This is the manual flow until there's a hosted Lifo tunnel service.
 */
export function DeviceTestingNote({ port }: DeviceTestingNoteProps) {
  return (
    <details className="mt-2 text-[12px] text-tokyo-comment">
      <summary className="cursor-pointer text-tokyo-fg-bright/80 hover:text-tokyo-fg-bright">
        📱 Test on your phone (Expo Go, over the tunnel)
      </summary>
      <div className="mt-1.5 space-y-1.5 leading-relaxed">
        <p>
          Metro runs inside this browser tab, so a small relay bridges it to your phone over your
          LAN. Until there's a hosted tunnel service, run these once:
        </p>
        <ol className="list-decimal ml-5 space-y-1">
          <li>
            On your Mac, from the lifo repo: <code>node apps/tunnel-server/server.js</code>{' '}
            (note your LAN IP: <code>ipconfig getifaddr en0</code>)
          </li>
          <li>
            In the terminal above: <code>tunnel --port {port} &amp;</code>
          </li>
          <li>
            <code>export EXPO_PACKAGER_PROXY_URL=http://&lt;your-mac-ip&gt;:3005</code>
          </li>
          <li>
            <code>npm run tunnel</code> — prints a QR + <code>exp://</code> URL
          </li>
          <li>
            Scan the QR with <strong>Expo Go</strong> (same Wi-Fi). Edits hot-reload on the device.
          </li>
        </ol>
        <p className="text-tokyo-comment/80">
          Both phone and Mac must be on the same network. <code>npm run tunnel</code> serves the
          native bundle; <code>npm run start</code> is the in-browser web preview above.
        </p>
      </div>
    </details>
  );
}
