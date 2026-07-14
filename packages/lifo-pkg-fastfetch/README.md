# lifo-pkg-fastfetch

`fastfetch` (and its `neofetch` alias) for [Lifo](https://lifo.sh) — a fast,
colorful system-info screen for the in-VM shell.

## Install

```sh
lifo install fastfetch
```

Or register it directly when embedding Lifo:

```ts
import { createDefaultRegistry } from '@lifo-sh/core';
import fastfetch from 'lifo-pkg-fastfetch';

const registry = createDefaultRegistry();
registry.register('fastfetch', fastfetch);
registry.register('neofetch', fastfetch);
```

## Usage

```sh
fastfetch [--logo default|small|none] [--color COLOR]
```

Reads optional config from `~/.config/fastfetch/config.json`.
