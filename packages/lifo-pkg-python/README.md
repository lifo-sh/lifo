# lifo-pkg-python

Python 3 for [Lifo](https://lifo.sh): `python`, `python3`, `pip` and `pip3`, backed by
[Pyodide](https://pyodide.org) (CPython compiled to WebAssembly). Install with
`lifo install python`, or register it when embedding:

```ts
import python, { pip } from 'lifo-pkg-python';
box.commands.register('python3', python);
box.commands.register('python', python);
box.commands.register('pip', pip);
```

- Runs `-c`, files (with `sys.argv`), `-m <module>`, programs on stdin, and an interactive prompt
  on a terminal. Exit codes follow `sys.exit`.
- Scripts see the box's files: HOME, `/tmp`, the working directory and the script's folder are
  copied into Python before each run, and what Python writes or deletes there is copied back.
  `node_modules`, `.git` and files over 32 MB are left out.
- `pip install` installs pure-Python wheels from PyPI and packages Pyodide builds (micropip).
  Packages Pyodide builds (numpy, pandas, …) also load by themselves when a script imports them.
- The interpreter loads on first use: about 6 MB from the jsdelivr CDN in a browser (cached
  after), the `pyodide` npm package in Node. Set `PYODIDE_INDEX_URL` to load it from elsewhere.

Limits: no native extensions Pyodide doesn't build, no subprocesses or threads, and Python runs
on the box's JS thread, so a long computation blocks the page until it finishes. `input()` from
a terminal needs a browser with JSPI (current Chrome); piped input always works.
