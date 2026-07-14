import { describe, it, expect } from 'vitest';
import { commandRedirect, npxRedirect, suggestForPackage } from '../../src/shell/command-suggestions.js';

describe('command redirects', () => {
  it('redirects `supabase` to `npx tinbase` with a note', () => {
    const r = commandRedirect('supabase');
    expect(r).toBeTruthy();
    expect(r!.runAs).toEqual(['npx', 'tinbase']);
    expect(r!.message).toContain('tinbase');
  });

  it('docker is note-only (no runAs to execute)', () => {
    const r = commandRedirect('docker');
    expect(r).toBeTruthy();
    expect(r!.runAs).toBeUndefined();
    expect(r!.message).toContain('Docker');
  });

  it('returns null for ordinary commands', () => {
    expect(commandRedirect('ls')).toBeNull();
    expect(commandRedirect('node')).toBeNull();
  });
});

describe('npx redirects', () => {
  it('maps npx supabase → tinbase', () => {
    const r = npxRedirect('supabase');
    expect(r).toEqual(expect.objectContaining({ to: 'tinbase' }));
    expect(r!.message).toContain('tinbase');
  });

  it('does not redirect npx for note-only or ordinary packages', () => {
    expect(npxRedirect('docker')).toBeNull(); // note-only, no pkg
    expect(npxRedirect('react')).toBeNull();
  });
});

describe('npm install notes', () => {
  it('notes the supabase package (with or without a version tag)', () => {
    expect(suggestForPackage('supabase')).toContain('tinbase');
    expect(suggestForPackage('supabase@2.1.0')).toContain('tinbase');
  });

  it('does NOT trip on the legit @supabase/supabase-js client library', () => {
    expect(suggestForPackage('@supabase/supabase-js')).toBeNull();
    expect(suggestForPackage('@supabase/supabase-js@2.110.0')).toBeNull();
  });

  it('returns null for ordinary packages', () => {
    expect(suggestForPackage('react')).toBeNull();
    expect(suggestForPackage('express')).toBeNull();
  });
});
