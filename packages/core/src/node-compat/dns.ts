/**
 * Node.js `dns` module shim for Lifo.
 *
 * Real DNS resolution is not available in the browser. The callback-style API
 * invokes callbacks with an ENOTFOUND error, while the promises API rejects.
 * `lookup` is the most commonly used function so it gets special treatment:
 * for "localhost" it resolves to 127.0.0.1, everything else errors.
 */

const NOTFOUND = 'ENOTFOUND';

function makeError(hostname: string, syscall: string): Error & { code: string; hostname: string; syscall: string } {
  const err = new Error(`getaddrinfo ${NOTFOUND} ${hostname}`) as Error & { code: string; hostname: string; syscall: string };
  err.code = NOTFOUND;
  err.hostname = hostname;
  err.syscall = syscall;
  return err;
}

type LookupCallback = (err: Error | null, address?: string, family?: number) => void;
type LookupAllCallback = (err: Error | null, addresses?: Array<{ address: string; family: number }>) => void;

function lookup(hostname: string, options: { all: true }, cb: LookupAllCallback): void;
function lookup(hostname: string, options: { family?: number } | number, cb: LookupCallback): void;
function lookup(hostname: string, cb: LookupCallback): void;
function lookup(
  hostname: string,
  optionsOrCb?: { all?: boolean; family?: number } | number | LookupCallback | LookupAllCallback,
  cb?: LookupCallback | LookupAllCallback,
): void {
  let callback: LookupCallback | LookupAllCallback;
  let all = false;

  if (typeof optionsOrCb === 'function') {
    callback = optionsOrCb;
  } else {
    if (typeof optionsOrCb === 'object' && optionsOrCb?.all) all = true;
    callback = cb!;
  }

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    if (all) {
      (callback as LookupAllCallback)(null, [{ address: '127.0.0.1', family: 4 }]);
    } else {
      (callback as LookupCallback)(null, '127.0.0.1', 4);
    }
    return;
  }

  callback(makeError(hostname, 'getaddrinfo'));
}

function resolve(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void;
function resolve(hostname: string, rrtype: string, cb: (err: Error | null, addresses?: unknown[]) => void): void;
function resolve(
  hostname: string,
  rrtypeOrCb: string | ((err: Error | null, addresses?: string[]) => void),
  cb?: (err: Error | null, addresses?: unknown[]) => void,
): void {
  const callback = typeof rrtypeOrCb === 'function' ? rrtypeOrCb : cb!;
  callback(makeError(hostname, 'queryA'));
}

function resolve4(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void {
  cb(makeError(hostname, 'queryA'));
}

function resolve6(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void {
  cb(makeError(hostname, 'queryAaaa'));
}

function resolveMx(hostname: string, cb: (err: Error | null, addresses?: Array<{ exchange: string; priority: number }>) => void): void {
  cb(makeError(hostname, 'queryMx'));
}

function resolveTxt(hostname: string, cb: (err: Error | null, addresses?: string[][]) => void): void {
  cb(makeError(hostname, 'queryTxt'));
}

function resolveSrv(hostname: string, cb: (err: Error | null, addresses?: Array<{ name: string; port: number; priority: number; weight: number }>) => void): void {
  cb(makeError(hostname, 'querySrv'));
}

function resolveNs(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void {
  cb(makeError(hostname, 'queryNs'));
}

function resolveCname(hostname: string, cb: (err: Error | null, addresses?: string[]) => void): void {
  cb(makeError(hostname, 'queryCname'));
}

function reverse(ip: string, cb: (err: Error | null, hostnames?: string[]) => void): void {
  cb(makeError(ip, 'getHostByAddr'));
}

function setServers(_servers: string[]): void {
  // no-op
}

function getServers(): string[] {
  return [];
}

// dns.promises API
const promises = {
  lookup: (hostname: string, options?: { all?: boolean; family?: number } | number): Promise<{ address: string; family: number } | Array<{ address: string; family: number }>> => {
    return new Promise((resolve, reject) => {
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        const entry = { address: '127.0.0.1', family: 4 };
        if (typeof options === 'object' && options?.all) {
          resolve([entry]);
        } else {
          resolve(entry);
        }
        return;
      }
      reject(makeError(hostname, 'getaddrinfo'));
    });
  },
  resolve: (hostname: string, _rrtype?: string): Promise<string[]> => {
    return Promise.reject(makeError(hostname, 'queryA'));
  },
  resolve4: (hostname: string): Promise<string[]> => {
    return Promise.reject(makeError(hostname, 'queryA'));
  },
  resolve6: (hostname: string): Promise<string[]> => {
    return Promise.reject(makeError(hostname, 'queryAaaa'));
  },
  reverse: (ip: string): Promise<string[]> => {
    return Promise.reject(makeError(ip, 'getHostByAddr'));
  },
  setServers: (_servers: string[]): void => { /* no-op */ },
  getServers: (): string[] => [],
};

// Error code constants
const ADDRGETNETWORKPARAMS = 'EADDRGETNETWORKPARAMS';
const BADFAMILY = 'EBADFAMILY';
const BADFLAGS = 'EBADFLAGS';
const BADHINTS = 'EBADHINTS';
const BADNAME = 'EBADNAME';
const BADQUERY = 'EBADQUERY';
const BADRESP = 'EBADRESP';
const BADSTR = 'EBADSTR';
const CANCELLED = 'ECANCELLED';
const CONNREFUSED = 'ECONNREFUSED';
const DESTRUCTION = 'EDESTRUCTION';
const EOF = 'EEOF';
const FILE = 'EFILE';
const FORMERR = 'EFORMERR';
const LOADIPHLPAPI = 'ELOADIPHLPAPI';
const NODATA = 'ENODATA';
const NOMEM = 'ENOMEM';
const NONAME = 'ENONAME';
const NOTINITIALIZED = 'ENOTINITIALIZED';
const REFUSED = 'EREFUSED';
const SERVFAIL = 'ESERVFAIL';
const TIMEOUT = 'ETIMEOUT';

export {
  lookup,
  resolve,
  resolve4,
  resolve6,
  resolveMx,
  resolveTxt,
  resolveSrv,
  resolveNs,
  resolveCname,
  reverse,
  setServers,
  getServers,
  promises,
  NOTFOUND,
  ADDRGETNETWORKPARAMS,
  BADFAMILY,
  BADFLAGS,
  BADHINTS,
  BADNAME,
  BADQUERY,
  BADRESP,
  BADSTR,
  CANCELLED,
  CONNREFUSED,
  DESTRUCTION,
  EOF,
  FILE,
  FORMERR,
  LOADIPHLPAPI,
  NODATA,
  NOMEM,
  NONAME,
  NOTINITIALIZED,
  REFUSED,
  SERVFAIL,
  TIMEOUT,
};

export default {
  lookup,
  resolve,
  resolve4,
  resolve6,
  resolveMx,
  resolveTxt,
  resolveSrv,
  resolveNs,
  resolveCname,
  reverse,
  setServers,
  getServers,
  promises,
  NOTFOUND,
};
