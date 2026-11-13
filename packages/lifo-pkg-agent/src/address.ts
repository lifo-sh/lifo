// Which IP addresses the browse proxy may connect to: public unicast only. Everything a server
// could reach that the visitor couldn't (its own loopback, the private network it sits in, cloud
// metadata endpoints, carrier NAT, link-local, multicast, reserved and documentation ranges) is
// refused, including IPv6 forms that embed an IPv4 address (mapped, NAT64, 6to4, compatible).

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including 169.254.169.254 (cloud metadata)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and 255.255.255.255
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function isPublicV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return false;
  for (const [base, bits] of V4_BLOCKED) {
    const b = v4ToInt(base)!;
    const size = 2 ** (32 - bits);
    if (n >= b && n < b + size) return false;
  }
  return true;
}

/** Expands an IPv6 address to 8 16-bit groups, or null if it isn't one. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two groups.
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = v4ToInt(dotted[2]);
    if (n === null) return null;
    s = `${dotted[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':') : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  const groups: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups;
}

const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isPublicV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return false;
  const zeroUpTo = (i: number) => g.slice(0, i).every((x) => x === 0);
  if (zeroUpTo(8)) return false; // ::
  if (zeroUpTo(7) && g[7] === 1) return false; // ::1
  if (zeroUpTo(5) && g[5] === 0xffff) return isPublicV4(v4From(g[6], g[7])); // ::ffff:a.b.c.d
  if (zeroUpTo(6)) return isPublicV4(v4From(g[6], g[7])); // ::a.b.c.d (deprecated compatible form)
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPublicV4(v4From(g[6], g[7])); // NAT64 64:ff9b::/96 and /48
  if (g[0] === 0x2002) return isPublicV4(v4From(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return false; // fec0::/10 old site-local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard-only 100::/64
  if (g[0] === 0x2001 && g[1] < 0x0200) return false; // 2001::/23 IETF special purpose (Teredo, ORCHID…)
  return (g[0] & 0xe000) === 0x2000; // global unicast is 2000::/3; anything else is reserved
}

/** True only for a public unicast IPv4 or IPv6 address. Anything unparseable is not public. */
export function isPublicAddress(ip: string): boolean {
  const s = ip.trim().replace(/^\[|\]$/g, '');
  if (s.includes(':')) return isPublicV6(s);
  return isPublicV4(s);
}
