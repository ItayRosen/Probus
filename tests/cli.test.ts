import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('parseArgs', () => {
  it('returns run with defaults when no args are given', () => {
    expect(parseArgs([])).toEqual({ kind: 'run', port: null, openBrowser: true });
  });

  it('returns help on --help / -h', () => {
    expect(parseArgs(['--help']).kind).toBe('help');
    expect(parseArgs(['-h']).kind).toBe('help');
  });

  it('accepts --port 9091', () => {
    const r = parseArgs(['--port', '9091']);
    expect(r).toEqual({ kind: 'run', port: 9091, openBrowser: true });
  });

  it('accepts --port=8080', () => {
    const r = parseArgs(['--port=8080']);
    expect(r).toEqual({ kind: 'run', port: 8080, openBrowser: true });
  });

  it('rejects --port outside 0..65535', () => {
    expect(parseArgs(['--port', '70000']).kind).toBe('error');
    expect(parseArgs(['--port', '-1']).kind).toBe('error');
    expect(parseArgs(['--port', 'words']).kind).toBe('error');
  });

  it('honors --no-open', () => {
    const r = parseArgs(['--no-open']);
    expect(r).toEqual({ kind: 'run', port: null, openBrowser: false });
  });

  it('honors --open after --no-open', () => {
    const r = parseArgs(['--no-open', '--open']);
    expect(r).toEqual({ kind: 'run', port: null, openBrowser: true });
  });

  it('rejects unknown args (including the old scan/view subcommands)', () => {
    expect(parseArgs(['scan']).kind).toBe('error');
    expect(parseArgs(['view', '../repo']).kind).toBe('error');
    expect(parseArgs(['--frobnicate']).kind).toBe('error');
  });
});
