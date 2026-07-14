import type { Command } from '@lifo-sh/core';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function renderMonth(year: number, month: number, highlightToday: boolean): string {
  const today = new Date();
  const isCurrentMonth = highlightToday && today.getFullYear() === year && today.getMonth() === month;
  const todayDate = today.getDate();

  const title = `${MONTH_NAMES[month]} ${year}`;
  const header = 'Su Mo Tu We Th Fr Sa';

  const lines: string[] = [];
  lines.push(title.padStart(Math.floor((20 + title.length) / 2)).padEnd(20));
  lines.push(header);

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let line = '   '.repeat(firstDay);
  let dayOfWeek = firstDay;

  for (let day = 1; day <= daysInMonth; day++) {
    const dayStr = String(day).padStart(2, ' ');
    if (isCurrentMonth && day === todayDate) {
      line += `\x1b[7m${dayStr}\x1b[0m`;
    } else {
      line += dayStr;
    }

    dayOfWeek++;
    if (dayOfWeek === 7 && day < daysInMonth) {
      lines.push(line);
      line = '';
      dayOfWeek = 0;
    } else if (day < daysInMonth) {
      line += ' ';
    }
  }

  if (line.length > 0) {
    lines.push(line);
  }

  return lines.join('\n') + '\n';
}

const command: Command = async (ctx) => {
  const today = new Date();
  const args = ctx.args.filter(a => !a.startsWith('-'));

  if (args.length === 0) {
    // Current month
    ctx.stdout.write(renderMonth(today.getFullYear(), today.getMonth(), true));
  } else if (args.length === 1) {
    const val = parseInt(args[0], 10);
    if (isNaN(val) || val < 1) {
      ctx.stderr.write(`cal: invalid argument: ${args[0]}\n`);
      return 1;
    }
    if (val > 12) {
      // Full year
      const year = val;
      for (let m = 0; m < 12; m++) {
        ctx.stdout.write(renderMonth(year, m, today.getFullYear() === year));
        if (m < 11) ctx.stdout.write('\n');
      }
    } else {
      // Month of current year
      ctx.stdout.write(renderMonth(today.getFullYear(), val - 1, true));
    }
  } else {
    // month year
    const month = parseInt(args[0], 10);
    const year = parseInt(args[1], 10);
    if (isNaN(month) || month < 1 || month > 12 || isNaN(year) || year < 1) {
      ctx.stderr.write(`cal: invalid arguments\n`);
      return 1;
    }
    const highlightToday = today.getFullYear() === year && today.getMonth() === month - 1;
    ctx.stdout.write(renderMonth(year, month - 1, highlightToday));
  }

  return 0;
};

export default command;
