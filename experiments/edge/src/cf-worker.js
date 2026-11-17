// A Cloudflare Worker that boots a Lifo box per request and runs the workload.
import { lifoRun } from './lifo-run.js';
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const r = await lifoRun({ skipNetwork: url.searchParams.has('offline') });
    return Response.json({ host: 'workerd (production flags' + (globalThis.process ? ', nodejs_compat' : '') + ')', ...r });
  },
};
