import type { Command } from '../types.js';

function processFormat(format: string, args: string[]): { output: string; consumed: number } {
  let result = '';
  let argIdx = 0;
  let i = 0;

  while (i < format.length) {
    if (format[i] === '\\') {
      i++;
      if (i < format.length) {
        switch (format[i]) {
          case 'n': result += '\n'; break;
          case 't': result += '\t'; break;
          case '\\': result += '\\'; break;
          case 'r': result += '\r'; break;
          case '0': result += '\0'; break;
          default: result += '\\' + format[i]; break;
        }
        i++;
      }
    } else if (format[i] === '%') {
      i++;
      if (i >= format.length) break;

      if (format[i] === '%') {
        result += '%';
        i++;
        continue;
      }

      const arg = args[argIdx++] || '';

      switch (format[i]) {
        case 's':
          result += arg;
          break;
        case 'd':
          result += String(parseInt(arg, 10) || 0);
          break;
        case 'f':
          result += String(parseFloat(arg) || 0);
          break;
        case 'x':
          result += (parseInt(arg, 10) || 0).toString(16);
          break;
        case 'o':
          result += (parseInt(arg, 10) || 0).toString(8);
          break;
        default:
          result += '%' + format[i];
          break;
      }
      i++;
    } else {
      result += format[i];
      i++;
    }
  }

  return { output: result, consumed: argIdx };
}

const command: Command = async (ctx) => {
  if (ctx.args.length === 0) {
    ctx.stderr.write('printf: missing format string\n');
    return 1;
  }

  const format = ctx.args[0];
  let args = ctx.args.slice(1);
  // The format is reused until every argument is consumed, as in POSIX printf:
  // `printf '%s\n' a b c` prints three lines. A format with no conversions prints once.
  let output = '';
  do {
    const { output: chunk, consumed } = processFormat(format, args);
    output += chunk;
    if (consumed === 0) break;
    args = args.slice(consumed);
  } while (args.length > 0);
  ctx.stdout.write(output);

  return 0;
};

export default command;
