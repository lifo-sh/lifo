# lifo-pkg-python

## 0.1.0

- `python`, `python3`, `pip` and `pip3` on Pyodide 314.0.7 (Python 3.14): `-c`, files, `-m`,
  stdin programs, an interactive prompt, `pip install`/`list`/`uninstall`, and file sync with
  the box.
- Runs in workerd (Lifo Cloud boxes), which can't `import()` a URL, compile WebAssembly
  asynchronously or `fetch` with `integrity`: there Pyodide's scripts are fetched and evaluated,
  WebAssembly compiles synchronously and package integrity is checked by this package.
- `pip -v` / `PIP_VERBOSE=1`: the package loader's messages and full errors.
