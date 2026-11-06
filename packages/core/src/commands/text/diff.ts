import type { Command } from '../types.js';
import { parseArgs } from '../../utils/args.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { isBinaryFile } from '../../utils/mime.js';

const spec = {
  unified: { type: 'boolean' as const, short: 'u' },
};

interface EditOp {
  type: 'keep' | 'delete' | 'insert';
  oldLine?: string;
  newLine?: string;
}

function computeLCS(a: string[], b: string[]): EditOp[] {
  const m = a.length;
  const n = b.length;

  // Build DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to get edit operations
  const ops: EditOp[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: 'keep', oldLine: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'insert', newLine: b[j - 1] });
      j--;
    } else {
      ops.push({ type: 'delete', oldLine: a[i - 1] });
      i--;
    }
  }

  return ops.reverse();
}

function formatNormal(ops: EditOp[]): string {
  const output: string[] = [];
  let oldIdx = 0;
  let newIdx = 0;
  let i = 0;

  while (i < ops.length) {
    const op = ops[i];
    if (op.type === 'keep') {
      oldIdx++; newIdx++; i++;
      continue;
    }

    // Collect contiguous change block
    const delStart = oldIdx;
    const insStart = newIdx;
    const delLines: string[] = [];
    const insLines: string[] = [];

    while (i < ops.length && ops[i].type !== 'keep') {
      if (ops[i].type === 'delete') {
        delLines.push(ops[i].oldLine!);
        oldIdx++;
      } else {
        insLines.push(ops[i].newLine!);
        newIdx++;
      }
      i++;
    }

    // Format range
    const delRange = delLines.length === 1
      ? `${delStart + 1}`
      : delLines.length > 0
        ? `${delStart + 1},${delStart + delLines.length}`
        : `${delStart}`;

    const insRange = insLines.length === 1
      ? `${insStart + 1}`
      : insLines.length > 0
        ? `${insStart + 1},${insStart + insLines.length}`
        : `${insStart}`;

    if (delLines.length > 0 && insLines.length > 0) {
      output.push(`${delRange}c${insRange}`);
      for (const l of delLines) output.push(`< ${l}`);
      output.push('---');
      for (const l of insLines) output.push(`> ${l}`);
    } else if (delLines.length > 0) {
      output.push(`${delRange}d${insRange}`);
      for (const l of delLines) output.push(`< ${l}`);
    } else {
      output.push(`${delRange}a${insRange}`);
      for (const l of insLines) output.push(`> ${l}`);
    }
  }

  return output.length > 0 ? output.join('\n') + '\n' : '';
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function formatUnified(ops: EditOp[], file1: string, file2: string): string {
  if (ops.every(o => o.type === 'keep')) return '';

  // Build annotated lines with indices
  const annotated: Array<{ type: 'keep' | 'delete' | 'insert'; line: string; oldIdx: number; newIdx: number }> = [];
  let oldIdx = 0, newIdx = 0;
  for (const op of ops) {
    if (op.type === 'keep') {
      annotated.push({ type: 'keep', line: op.oldLine!, oldIdx, newIdx });
      oldIdx++; newIdx++;
    } else if (op.type === 'delete') {
      annotated.push({ type: 'delete', line: op.oldLine!, oldIdx, newIdx });
      oldIdx++;
    } else {
      annotated.push({ type: 'insert', line: op.newLine!, oldIdx, newIdx });
      newIdx++;
    }
  }

  // Group into hunks with 3 lines of context
  const context = 3;
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;
  let lastChangeIdx = -Infinity;

  for (let i = 0; i < annotated.length; i++) {
    const a = annotated[i];
    if (a.type !== 'keep') {
      if (!currentHunk || i - lastChangeIdx > context * 2 + 1) {
        // Start new hunk with leading context
        if (currentHunk) {
          // Add trailing context to previous hunk
          for (let j = lastChangeIdx + 1; j < Math.min(lastChangeIdx + 1 + context, annotated.length); j++) {
            if (annotated[j].type === 'keep') {
              currentHunk.lines.push(` ${annotated[j].line}`);
              currentHunk.oldCount++;
              currentHunk.newCount++;
            }
          }
          hunks.push(currentHunk);
        }

        const ctxStart = Math.max(0, i - context);
        // Count old/new lines from context start
        let oStart = 0, nStart = 0;
        for (let j = 0; j < ctxStart; j++) {
          if (annotated[j].type !== 'insert') oStart++;
          if (annotated[j].type !== 'delete') nStart++;
        }

        currentHunk = {
          oldStart: oStart + 1,
          newStart: nStart + 1,
          oldCount: 0,
          newCount: 0,
          lines: [],
        };

        for (let j = ctxStart; j < i; j++) {
          if (annotated[j].type === 'keep') {
            currentHunk.lines.push(` ${annotated[j].line}`);
            currentHunk.oldCount++;
            currentHunk.newCount++;
          }
        }
      } else if (i - lastChangeIdx > 1) {
        // Add intermediate context
        for (let j = lastChangeIdx + 1; j < i; j++) {
          if (annotated[j].type === 'keep') {
            currentHunk!.lines.push(` ${annotated[j].line}`);
            currentHunk!.oldCount++;
            currentHunk!.newCount++;
          }
        }
      }

      if (a.type === 'delete') {
        currentHunk!.lines.push(`-${a.line}`);
        currentHunk!.oldCount++;
      } else {
        currentHunk!.lines.push(`+${a.line}`);
        currentHunk!.newCount++;
      }
      lastChangeIdx = i;
    }
  }

  if (currentHunk) {
    // Trailing context
    for (let j = lastChangeIdx + 1; j < Math.min(lastChangeIdx + 1 + context, annotated.length); j++) {
      if (annotated[j].type === 'keep') {
        currentHunk.lines.push(` ${annotated[j].line}`);
        currentHunk.oldCount++;
        currentHunk.newCount++;
      }
    }
    hunks.push(currentHunk);
  }

  const output: string[] = [];
  output.push(`--- ${file1}`);
  output.push(`+++ ${file2}`);
  for (const hunk of hunks) {
    output.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    output.push(...hunk.lines);
  }

  return output.join('\n') + '\n';
}

const command: Command = async (ctx) => {
  const { flags, positional } = parseArgs(ctx.args, spec);

  if (positional.length < 2) {
    ctx.stderr.write('diff: missing operand\n');
    return 2;
  }

  const file1 = positional[0];
  const file2 = positional[1];

  let content1: string;
  let content2: string;

  const path1 = resolve(ctx.cwd, file1);
  const path2 = resolve(ctx.cwd, file2);
  const binary1 = isBinaryFile(ctx.vfs, path1);
  const binary2 = isBinaryFile(ctx.vfs, path2);

  if (binary1 || binary2) {
    // Verify files exist before reporting binary diff
    try { ctx.vfs.stat(path1); } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`diff: ${file1}: ${e.message}
`);
        return 2;
      }
      throw e;
    }
    try { ctx.vfs.stat(path2); } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`diff: ${file2}: ${e.message}
`);
        return 2;
      }
      throw e;
    }
    ctx.stdout.write(`Binary files ${file1} and ${file2} differ
`);
    return 2;
  }

  try {
    content1 = ctx.vfs.readFileString(resolve(ctx.cwd, file1));
  } catch (e) {
    if (e instanceof VFSError) {
      ctx.stderr.write(`diff: ${file1}: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  try {
    content2 = ctx.vfs.readFileString(resolve(ctx.cwd, file2));
  } catch (e) {
    if (e instanceof VFSError) {
      ctx.stderr.write(`diff: ${file2}: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  if (content1 === content2) {
    return 0;
  }

  const lines1 = content1.split('\n');
  const lines2 = content2.split('\n');

  // Remove trailing empty from final newline
  if (lines1.length > 0 && lines1[lines1.length - 1] === '') lines1.pop();
  if (lines2.length > 0 && lines2[lines2.length - 1] === '') lines2.pop();

  const ops = computeLCS(lines1, lines2);

  if (flags.unified) {
    ctx.stdout.write(formatUnified(ops, file1, file2));
  } else {
    ctx.stdout.write(formatNormal(ops));
  }

  return 1;
};

export default command;
