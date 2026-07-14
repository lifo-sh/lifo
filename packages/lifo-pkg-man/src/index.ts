import type { Command } from '@lifo-sh/core';

const PAGES: Record<string, { synopsis: string; description: string }> = {
  // Shell builtins
  cd: { synopsis: 'cd [DIR]', description: 'Change the current working directory to DIR. If DIR is not specified, change to HOME.' },
  pwd: { synopsis: 'pwd', description: 'Print the current working directory.' },
  echo: { synopsis: 'echo [STRING...]', description: 'Write arguments to standard output, separated by spaces, followed by a newline.' },
  clear: { synopsis: 'clear', description: 'Clear the terminal screen.' },
  export: { synopsis: 'export NAME=VALUE...', description: 'Set environment variables.' },
  exit: { synopsis: 'exit', description: 'Exit the shell.' },
  true: { synopsis: 'true', description: 'Return a successful (zero) exit status.' },
  false: { synopsis: 'false', description: 'Return an unsuccessful (non-zero) exit status.' },
  jobs: { synopsis: 'jobs', description: 'List active background jobs.' },
  fg: { synopsis: 'fg [JOB_ID]', description: 'Move a background job to the foreground.' },
  bg: { synopsis: 'bg [JOB_ID]', description: 'Resume a stopped background job.' },
  history: { synopsis: 'history', description: 'Display the command history list.' },
  source: { synopsis: 'source FILE', description: 'Read and execute commands from FILE in the current shell environment. Shell sources /etc/profile and ~/.liforc on startup.' },
  alias: { synopsis: 'alias [NAME=VALUE...]', description: 'Define or display aliases. Without arguments, lists all aliases.' },
  unalias: { synopsis: 'unalias NAME...', description: 'Remove alias definitions.' },

  // Filesystem
  ls: { synopsis: 'ls [-laR1h] [FILE...]', description: 'List directory contents. -l for long format, -a to show hidden files, -R recursive, -1 one per line, -h human-readable sizes.' },
  cat: { synopsis: 'cat [FILE...]', description: 'Concatenate and print files to standard output.' },
  mkdir: { synopsis: 'mkdir [-p] DIR...', description: 'Create directories. -p creates parent directories as needed.' },
  rm: { synopsis: 'rm [-rf] FILE...', description: 'Remove files or directories. -r recursive, -f force (no error if missing).' },
  cp: { synopsis: 'cp [-r] SOURCE DEST', description: 'Copy files and directories. -r for recursive copy.' },
  mv: { synopsis: 'mv SOURCE DEST', description: 'Move or rename files and directories.' },
  touch: { synopsis: 'touch FILE...', description: 'Create empty files or update access/modification times.' },
  find: { synopsis: 'find [PATH] [-name PATTERN] [-type TYPE]', description: 'Search for files in a directory hierarchy.' },
  tree: { synopsis: 'tree [DIR]', description: 'Display directory structure as a tree.' },
  stat: { synopsis: 'stat FILE...', description: 'Display file status and metadata.' },
  ln: { synopsis: 'ln [-s] TARGET LINK', description: 'Create links between files. -s for symbolic links.' },
  du: { synopsis: 'du [-sh] [FILE...]', description: 'Estimate file space usage. -s summary only, -h human-readable.' },
  df: { synopsis: 'df [-h]', description: 'Report filesystem disk space usage. -h human-readable.' },
  chmod: { synopsis: 'chmod MODE FILE...', description: 'Change file mode bits.' },
  file: { synopsis: 'file FILE...', description: 'Determine file type.' },
  rmdir: { synopsis: 'rmdir [-p] DIR...', description: 'Remove empty directories. -p removes parent directories as well.' },
  realpath: { synopsis: 'realpath FILE...', description: 'Print the resolved absolute path for each FILE.' },
  basename: { synopsis: 'basename NAME [SUFFIX]', description: 'Strip directory and optional SUFFIX from NAME.' },
  dirname: { synopsis: 'dirname NAME...', description: 'Strip last component from each NAME, outputting the parent directory.' },
  mktemp: { synopsis: 'mktemp [-d] [-p DIR] [TEMPLATE]', description: 'Create a temporary file or directory. -d creates a directory. TEMPLATE defaults to tmp.XXXXXXXXXX.' },
  chown: { synopsis: 'chown [-R] OWNER[:GROUP] FILE...', description: 'Change file owner and group (no-op in single-user Lifo).' },

  // Text processing
  grep: { synopsis: 'grep [-invcrl] PATTERN [FILE...]', description: 'Search for lines matching PATTERN. -i ignore case, -n line numbers, -v invert, -c count, -r recursive, -l files only.' },
  head: { synopsis: 'head [-n NUM] [FILE...]', description: 'Output the first NUM lines of each FILE (default 10).' },
  tail: { synopsis: 'tail [-n NUM] [FILE...]', description: 'Output the last NUM lines of each FILE (default 10).' },
  wc: { synopsis: 'wc [-lwc] [FILE...]', description: 'Print newline, word, and byte counts. -l lines, -w words, -c bytes.' },
  sort: { synopsis: 'sort [-rnuk] [FILE...]', description: 'Sort lines of text. -r reverse, -n numeric, -u unique, -k key field.' },
  uniq: { synopsis: 'uniq [-cdi] [FILE]', description: 'Report or omit repeated lines. -c count, -d only duplicates, -i ignore case.' },
  cut: { synopsis: 'cut -d DELIM -f LIST [FILE...]', description: 'Cut out selected fields from each line. -d delimiter, -f fields.' },
  tr: { synopsis: 'tr [-ds] SET1 [SET2]', description: 'Translate or delete characters. -d delete, -s squeeze repeats.' },
  sed: { synopsis: 'sed [-i] SCRIPT [FILE...]', description: 'Stream editor for filtering and transforming text.' },
  awk: { synopsis: "awk [-F SEP] 'PROGRAM' [FILE...]", description: 'Pattern scanning and text processing language.' },
  diff: { synopsis: 'diff [-u] FILE1 FILE2', description: 'Compare files line by line. -u unified format. Exit: 0=same, 1=different, 2=error.' },
  nl: { synopsis: 'nl [-b STYLE] [-w WIDTH] [FILE]', description: 'Number lines. -b a (all), -b t (non-empty, default). -w sets number width (default 6).' },
  rev: { synopsis: 'rev [FILE...]', description: 'Reverse characters in each line.' },

  // I/O
  tee: { synopsis: 'tee [-a] FILE...', description: 'Read from stdin and write to stdout and files. -a append.' },
  xargs: { synopsis: 'xargs [COMMAND [ARGS...]]', description: 'Build and execute commands from standard input.' },
  yes: { synopsis: 'yes [STRING]', description: 'Repeatedly output STRING (default "y") until killed.' },
  printf: { synopsis: "printf FORMAT [ARGS...]", description: 'Format and print data. Supports %s, %d, %f, %x, and escape sequences.' },

  // System
  env: { synopsis: 'env', description: 'Print all environment variables.' },
  uname: { synopsis: 'uname [-asnrm]', description: 'Print system information. -a all, -s kernel name, -n hostname, -r release, -m machine.' },
  date: { synopsis: 'date [+FORMAT]', description: 'Display the current date and time. FORMAT uses % directives like %Y, %m, %d.' },
  sleep: { synopsis: 'sleep SECONDS', description: 'Delay for a specified number of seconds.' },
  uptime: { synopsis: 'uptime', description: 'Show how long the system has been running.' },
  whoami: { synopsis: 'whoami', description: 'Print the current user name.' },
  hostname: { synopsis: 'hostname', description: 'Print the system hostname.' },
  free: { synopsis: 'free [-h]', description: 'Display amount of free and used memory.' },
  which: { synopsis: 'which COMMAND...', description: 'Locate a command, showing if it is a builtin or external command.' },
  ps: { synopsis: 'ps', description: 'Report a snapshot of current processes. Shell is PID 1, background jobs follow.' },
  top: { synopsis: 'top', description: 'Display a single snapshot of system processes, memory, and CPU information.' },
  kill: { synopsis: 'kill [-SIGNAL] PID|%JOB...', description: 'Send a signal to a process or job. -l lists signals. Supports PID or %JOB notation.' },
  watch: { synopsis: 'watch [-n SEC] COMMAND [ARGS...]', description: 'Execute COMMAND repeatedly, displaying output. -n sets interval (default 2s). Ctrl+C to stop.' },
  cal: { synopsis: 'cal [MONTH YEAR]', description: 'Display a calendar. No args: current month. One arg >12: full year. Two args: specific month and year.' },
  bc: { synopsis: 'bc [-e EXPR]', description: 'An arbitrary precision calculator. Supports +, -, *, /, %, ^ (power), sqrt(), variables, and scale.' },
  man: { synopsis: 'man [-k] COMMAND', description: 'Display manual page for COMMAND. -k searches descriptions for a keyword.' },
  help: { synopsis: 'help', description: 'Display a list of all available commands grouped by category.' },

  // Network
  curl: { synopsis: 'curl [-sLo FILE] URL', description: 'Transfer data from a URL. -s silent, -L follow redirects, -o output file.' },
  wget: { synopsis: 'wget [-qO FILE] URL', description: 'Download files from the web. -q quiet, -O output file.' },
  ping: { synopsis: 'ping [-c COUNT] HOST', description: 'Send ICMP echo requests to a host (simulated).' },
  dig: { synopsis: 'dig HOST [TYPE]', description: 'DNS lookup utility (simulated).' },

  // Archive
  tar: { synopsis: 'tar [-cxtzf] [FILE...]', description: 'Archive utility. -c create, -x extract, -t list, -z gzip, -f archive file.' },
  gzip: { synopsis: 'gzip [-dk] FILE...', description: 'Compress files. -d decompress, -k keep original.' },
  gunzip: { synopsis: 'gunzip [-k] FILE...', description: 'Decompress gzip files. -k keep original.' },
  zip: { synopsis: 'zip [-r] ARCHIVE FILE...', description: 'Package and compress files. -r recursive.' },
  unzip: { synopsis: 'unzip [-lo] ARCHIVE', description: 'Extract files from a ZIP archive. -l list, -o overwrite.' },

  // Text editors & pagers
  nano: { synopsis: 'nano [FILE]', description: 'A simple text editor. ^O save, ^X exit, ^K cut line, ^U paste, ^W search, arrow keys to navigate.' },
  less: { synopsis: 'less [FILE]', description: 'View file contents one screen at a time. j/k scroll, f/b page, /pattern search, n/N next/prev match, q quit.' },

  // Text utilities (continued)
  seq: { synopsis: 'seq [-s SEP] [FIRST [INCR]] LAST', description: 'Print a sequence of numbers from FIRST to LAST with optional INCRement. -s sets separator (default newline).' },
  tac: { synopsis: 'tac [FILE...]', description: 'Concatenate and print files in reverse line order (opposite of cat).' },
  base64: { synopsis: 'base64 [-d] [-w COLS] [FILE]', description: 'Base64 encode or decode data. -d decode, -w wrap encoded lines at COLS (default 76, 0 disables).' },
  strings: { synopsis: 'strings [-n MIN] [FILE...]', description: 'Print sequences of printable characters from files. -n sets minimum string length (default 4).' },
  sha256sum: { synopsis: 'sha256sum [-c FILE] [FILE...]', description: 'Compute or verify SHA-256 checksums. -c reads checksums from FILE and verifies them.' },

  // Fun
  sl: { synopsis: 'sl', description: 'Steam Locomotive. Displays a train animation. A classic punishment for mistyping ls.' },
  fastfetch: { synopsis: 'fastfetch [--logo default|small|none] [--color COLOR]', description: 'Display system information with a custom Lifo logo. Config at ~/.config/fastfetch/config.json. Supports custom logos, colors (256-color), and module selection.' },
  neofetch: { synopsis: 'neofetch', description: 'Alias for fastfetch. Display system information with a custom Lifo logo.' },

  // Node.js
  node: { synopsis: 'node [-e CODE] [FILE]', description: 'Execute JavaScript using the Node.js-compatible runtime.' },
  pkg: { synopsis: 'pkg install|remove|list [PACKAGE]', description: 'Package manager for installing and managing packages.' },
};

const command: Command = async (ctx) => {
  if (ctx.args.length === 0) {
    ctx.stderr.write('man: missing command name\n');
    ctx.stderr.write('Usage: man [-k] COMMAND\n');
    return 1;
  }

  // Handle -k keyword search
  if (ctx.args[0] === '-k') {
    if (ctx.args.length < 2) {
      ctx.stderr.write('man: -k requires a keyword\n');
      return 1;
    }
    const keyword = ctx.args[1].toLowerCase();
    let found = false;

    for (const [name, page] of Object.entries(PAGES)) {
      if (
        name.includes(keyword) ||
        page.synopsis.toLowerCase().includes(keyword) ||
        page.description.toLowerCase().includes(keyword)
      ) {
        ctx.stdout.write(`${name}(1) - ${page.description.split('.')[0]}\n`);
        found = true;
      }
    }

    if (!found) {
      ctx.stderr.write(`man: nothing appropriate for "${ctx.args[1]}"\n`);
      return 1;
    }
    return 0;
  }

  const name = ctx.args[0];
  const page = PAGES[name];

  if (!page) {
    ctx.stderr.write(`man: no manual entry for ${name}\n`);
    return 1;
  }

  ctx.stdout.write(`NAME\n    ${name} - ${page.description.split('.')[0].toLowerCase()}\n\n`);
  ctx.stdout.write(`SYNOPSIS\n    ${page.synopsis}\n\n`);
  ctx.stdout.write(`DESCRIPTION\n    ${page.description}\n`);

  return 0;
};

export default command;
