import { describe, it, expect } from 'vitest';
import {
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
} from '../../src/node-compat/dns.js';

describe('dns shim', () => {
  describe('lookup', () => {
    it('resolves localhost to 127.0.0.1', () => {
      return new Promise<void>((done) => {
        lookup('localhost', (err, address, family) => {
          expect(err).toBeNull();
          expect(address).toBe('127.0.0.1');
          expect(family).toBe(4);
          done();
        });
      });
    });

    it('resolves 127.0.0.1 to itself', () => {
      return new Promise<void>((done) => {
        lookup('127.0.0.1', (err, address) => {
          expect(err).toBeNull();
          expect(address).toBe('127.0.0.1');
          done();
        });
      });
    });

    it('returns ENOTFOUND for other hostnames', () => {
      return new Promise<void>((done) => {
        lookup('example.com', (err) => {
          expect(err).not.toBeNull();
          expect((err as unknown as { code: string }).code).toBe('ENOTFOUND');
          expect((err as unknown as { hostname: string }).hostname).toBe('example.com');
          done();
        });
      });
    });

    it('supports options object with family', () => {
      return new Promise<void>((done) => {
        lookup('localhost', { family: 4 }, (err, address) => {
          expect(err).toBeNull();
          expect(address).toBe('127.0.0.1');
          done();
        });
      });
    });

    it('supports all option', () => {
      return new Promise<void>((done) => {
        lookup('localhost', { all: true }, (err, addresses) => {
          expect(err).toBeNull();
          expect(addresses).toEqual([{ address: '127.0.0.1', family: 4 }]);
          done();
        });
      });
    });
  });

  describe('resolve functions', () => {
    it('resolve returns ENOTFOUND', () => {
      return new Promise<void>((done) => {
        resolve('example.com', (err) => {
          expect((err as unknown as { code: string }).code).toBe('ENOTFOUND');
          done();
        });
      });
    });

    it('resolve with rrtype returns ENOTFOUND', () => {
      return new Promise<void>((done) => {
        resolve('example.com', 'A', (err) => {
          expect((err as unknown as { code: string }).code).toBe('ENOTFOUND');
          done();
        });
      });
    });

    it('resolve4 returns ENOTFOUND', () => {
      return new Promise<void>((done) => {
        resolve4('example.com', (err) => {
          expect((err as unknown as { code: string }).code).toBe('ENOTFOUND');
          done();
        });
      });
    });

    it('resolve6 returns ENOTFOUND', () => {
      return new Promise<void>((done) => {
        resolve6('example.com', (err) => {
          expect((err as unknown as { code: string }).code).toBe('ENOTFOUND');
          done();
        });
      });
    });

    it('resolveMx returns ENOTFOUND', () => {
      return new Promise<void>((done) => {
        resolveMx('example.com', (err) => {
          expect((err as unknown as { code: string }).code).toBe('ENOTFOUND');
          done();
        });
      });
    });

    it('resolveTxt returns ENOTFOUND', () => {
      return new Promise<void>((done) => {
        resolveTxt('example.com', (err) => {
          expect((err as unknown as { code: string }).code).toBe('ENOTFOUND');
          done();
        });
      });
    });

    it('resolveSrv returns ENOTFOUND', () => {
      return new Promise<void>((done) => {
        resolveSrv('example.com', (err) => {
          expect((err as unknown as { code: string }).code).toBe('ENOTFOUND');
          done();
        });
      });
    });

    it('resolveNs returns ENOTFOUND', () => {
      return new Promise<void>((done) => {
        resolveNs('example.com', (err) => {
          expect((err as unknown as { code: string }).code).toBe('ENOTFOUND');
          done();
        });
      });
    });

    it('resolveCname returns ENOTFOUND', () => {
      return new Promise<void>((done) => {
        resolveCname('example.com', (err) => {
          expect((err as unknown as { code: string }).code).toBe('ENOTFOUND');
          done();
        });
      });
    });

    it('reverse returns ENOTFOUND', () => {
      return new Promise<void>((done) => {
        reverse('1.2.3.4', (err) => {
          expect((err as unknown as { code: string }).code).toBe('ENOTFOUND');
          done();
        });
      });
    });
  });

  describe('setServers / getServers', () => {
    it('getServers returns empty array', () => {
      expect(getServers()).toEqual([]);
    });

    it('setServers is a no-op', () => {
      setServers(['8.8.8.8']);
      expect(getServers()).toEqual([]);
    });
  });

  describe('constants', () => {
    it('NOTFOUND equals ENOTFOUND', () => {
      expect(NOTFOUND).toBe('ENOTFOUND');
    });
  });

  describe('promises API', () => {
    it('lookup resolves localhost', async () => {
      const result = await promises.lookup('localhost');
      expect(result).toEqual({ address: '127.0.0.1', family: 4 });
    });

    it('lookup with all option returns array', async () => {
      const result = await promises.lookup('localhost', { all: true });
      expect(result).toEqual([{ address: '127.0.0.1', family: 4 }]);
    });

    it('lookup rejects for unknown host', async () => {
      await expect(promises.lookup('example.com')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    });

    it('resolve rejects', async () => {
      await expect(promises.resolve('example.com')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    });

    it('resolve4 rejects', async () => {
      await expect(promises.resolve4('example.com')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    });

    it('resolve6 rejects', async () => {
      await expect(promises.resolve6('example.com')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    });

    it('reverse rejects', async () => {
      await expect(promises.reverse('1.2.3.4')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    });

    it('getServers returns empty array', () => {
      expect(promises.getServers()).toEqual([]);
    });
  });
});
