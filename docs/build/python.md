# Python

`python3` in a box is CPython 3.14 compiled to WebAssembly by
[Pyodide](https://pyodide.org). It runs scripts from the box's filesystem, reads stdin,
writes files back, and installs pure-Python packages with `pip`. It comes from the
`lifo-pkg-python` package, which is already there in `lifo-sh` and in the boxes on lifo.sh.

```bash live
cd ~
printf 'name,score\nada,3\nlin,5\nkim,4\n' > scores.csv
python3 -c "import sys; print(sys.version.split()[0], sys.platform)"
python3 -c "import csv, statistics; rows = list(csv.DictReader(open('scores.csv'))); print('mean', statistics.mean(int(r['score']) for r in rows))"
echo '{"items": [1, 2, 3]}' | python3 -c "import json, sys; print(sum(json.load(sys.stdin)['items']))"
```

The first `python3` in a box downloads the interpreter: about 6 MB from the jsdelivr CDN in a
browser (cached by the browser after that), or the `pyodide` npm package in Node.js. It then
stays loaded for the box, so later runs start in milliseconds.

## From your code

Register the commands on a box, then run Python like any other command:

```js live
import { Sandbox } from '@lifo-sh/core';
import python, { pip } from 'lifo-pkg-python';   // npm install lifo-pkg-python

const box = await Sandbox.create();
box.commands.register('python3', python);
box.commands.register('pip', pip);

await box.fs.writeFile('/home/user/primes.py', `
import sys
n = int(sys.argv[1])
primes = [p for p in range(2, n) if all(p % d for d in range(2, int(p ** 0.5) + 1))]
open('primes.txt', 'w').write(' '.join(map(str, primes)))
print(len(primes), 'primes below', n)
`);
const { stdout, exitCode } = await box.commands.run('python3 primes.py 100');
console.log(stdout, exitCode);                              // 25 primes below 100 0
console.log(await box.fs.readFile('/home/user/primes.txt'));   // the file the script wrote
```

Register `python` too if scripts call it by that name. The package works the same in Node.js.

## What it runs

| | |
|---|---|
| `python3 -c "<code>" [args]` | a program from the command line |
| `python3 script.py [args]` | a file, with `sys.argv`; its folder is on `sys.path`, so local modules import |
| `python3 -m <module>` | a module as a script; `python3 -m pip ...` is `pip` |
| `python3 < prog.py`, `cat prog.py \| python3` | a program on stdin |
| `python3` | an interactive prompt, on a terminal |
| `pip install <pkg> ...`, `pip install -r requirements.txt` | packages from PyPI (see below) |
| `pip list`, `pip freeze`, `pip uninstall <pkg>` | |

Exit codes follow `sys.exit()`: `sys.exit(3)` exits 3, an uncaught exception prints its
traceback and exits 1. `os.environ` is the box's environment and `os.getcwd()` the shell's
directory.

## Files

Python has its own in-memory filesystem, so the box's files are copied into it before each run
and back out after:

- **In:** your home folder, `/tmp`, the current directory and the script's folder, at the same
  paths. Unchanged files aren't copied again on the next run.
- **Out:** whatever Python created, changed or deleted under those folders is written to the
  box, so `python3 report.py && cat report.txt` works and the file explorer shows the result.
- **Left out:** `node_modules`, `.git`, `__pycache__` and files over 32 MB. Python doesn't
  write `.pyc` files.

Paths outside those folders (`/usr`, `/etc`) aren't visible to Python. Run from the folder you
want it to see.

## Packages

- **Pure-Python packages** install from PyPI with `pip install` (it's
  [micropip](https://micropip.pyodide.org) underneath): `rich`, `attrs`, `cowsay` and any other
  wheel with no compiled code.
- **Packages Pyodide builds**, including numpy, pandas, scipy, scikit-learn, matplotlib and
  pyyaml, load by themselves the first time a script imports them (a download
  each, cached after). `pip install numpy` works too.
- Installed packages last as long as the box: until the page reloads, or the Node.js process
  exits.

```bash live
pip install cowsay
python3 -c "import cowsay; cowsay.cow('moo from a browser tab')"
```

## Limits

- **No native extensions** that Pyodide doesn't build. A wheel with compiled code for Linux or
  macOS won't install.
- **No subprocesses or threads.** `subprocess`, `os.fork` and `threading.Thread.start()` fail;
  `multiprocessing` doesn't work.
- **Sockets.** Raw sockets don't work. In a browser, `pyodide.http.pyfetch` and pure-Python
  HTTP clients built on it can make requests (subject to CORS).
- **It shares the box's thread.** A long computation blocks the page (or the Node.js event
  loop) until it ends, and Ctrl+C can't stop a busy loop.
- **`input()` on a terminal** needs a browser with JavaScript Promise Integration (current
  Chrome). Piped input (`echo 42 | python3 script.py`) works everywhere.
- **One interpreter per box.** Runs in the same box take turns; modules imported from your
  files are reloaded on each run, packages stay imported.

## In a cloud box

`python3` and `pip` work in [cloud boxes](../cloud/boxes.md) the same way, with the box's
files. What differs:

- **The interpreter loads again after every wake** (a cloud box keeps files, not memory): about
  2 seconds on the first `python3` or `pip` after the box boots or wakes, a few milliseconds
  after that. A box that has loaded Python uses roughly 60 to 190 MB more memory.
- **Installed packages don't survive a sleep.** `pip install` puts packages in the
  interpreter's memory, so install in the start command:
  `--start "pip install -r requirements.txt && python3 job.py"`.
- **A Python script can't be the box's server**: Python here has no sockets, so nothing listens
  on a port. Serve with Node.js and call Python for the work, or run Python with
  `lifo cloud exec`.
- `pip install -v` prints the package loader's messages and full errors, when an install fails.

`PYODIDE_INDEX_URL` in the box's environment loads Pyodide from another URL (a self-hosted
copy, for example), ending in `/`.
