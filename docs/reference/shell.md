# Shell and commands

## The shell

A bash-like shell. What works:

| | |
|---|---|
| Pipes and lists | `a \| b`, `a && b`, `a \|\| b`, `a; b`, `a &` (background) |
| Grouping | `{ a; b; }`, subshells `( cd dir && make )` (their `cd` and variables stay inside) |
| Redirects | `>`, `>>`, `<`, `2>`, `2>&1`, `&>`, also on loops and groups (`done < file`, `} > out`) |
| Here-docs | `<<EOF`, `<<-EOF` (strips tabs), `<<'EOF'` (no expansion), here-strings `<<< "text"` |
| Variables | `X=1`, `export X`, `local X`, `$X`, `${X:-default}`, `${#X}`, `${X%.txt}`, `$?`, `$1`, `$@`, `$#`, `$$`, `$!`, `$RANDOM` |
| Substitution | `$(cmd)`, `$((1 + 2))` |
| Expansion | `{a,b}`, `{1..10}`, `{01..10..2}`, `{a..e}`, `*.txt`, `**/*.js`, `~`; `\` escapes one character |
| Control flow | `if`/`elif`/`else`, `for`, `while`, `until`, `case` |
| Functions | `name() { ...; }`, `local`, `return`, `shift`, `set -- a b` |
| Input | `read [-r] [-p prompt] [name ...]`, so `while read line; do ...; done < file` works |
| Jobs | `jobs`, `fg`, `bg`, Ctrl+C |
| Interactive | history (up/down, Ctrl+R), tab completion, line editing; an unfinished command (`if ...`, `cat <<EOF`, a trailing `\|`) continues on a `> ` prompt |

At start it reads `/etc/profile` and `~/.bashrc`. It's not bash. Not supported yet: arrays,
`[[ ... ]]` (use `[ ... ]`), arithmetic commands `(( ... ))` (use `i=$((i + 1))`), `trap`,
and word splitting of unquoted variables (`for w in $LIST` sees one word; use a
`while read` loop). `set -e`, `-u`, `-x` and `-o pipefail` are accepted but not enforced
yet, so chain steps with `&&`. In `commands.run`, `$( )` and `( )`, `exit N` ends that run
with code N.

```bash live
mkdir -p demo/{src,test} && ls demo
for n in {1..3}; do echo "item $n"; done
printf "alpha 1\nbeta 2\n" > demo/notes.txt
while read name n; do echo "$name is $n"; done < demo/notes.txt
(cd demo/src && pwd); pwd
greet() { echo "hello, $1"; }
for name in lifo box shell; do greet "$name"; done | sort
n=0; while [ $n -lt 3 ]; do n=$((n + 1)); done; echo "n is $n"
case "$(uname -s)" in Lifo) echo "in a box";; *) echo "somewhere else";; esac
```

## Builtins

`cd`, `pwd`, `echo`, `read`, `export`, `local`, `set`, `shift`, `alias`, `unalias`, `source`
(`.`), `command` (`command -v name`), `type`, `history`, `jobs`, `fg`, `bg`, `true`, `false`,
`clear`, `exit`, `test` (`[`), `return`, `break`, `continue`.

## Commands

| | |
|---|---|
| Files | `ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `touch`, `ln`, `stat`, `find`, `tree`, `du`, `df`, `chmod`, `chown`, `file`, `basename`, `dirname`, `realpath`, `mktemp` |
| Text | `grep`, `sed`, `awk`, `head`, `tail`, `sort`, `uniq`, `wc`, `cut`, `tr`, `diff`, `nl`, `rev`, `tac`, `seq`, `strings`, `base64`, `sha256sum` |
| I/O | `printf`, `tee`, `xargs`, `yes` |
| System | `ps`, `top`, `kill`, `env`, `uname`, `whoami`, `hostname`, `uptime`, `free`, `date`, `sleep`, `watch`, `which`, `help`, `systemctl` |
| Network | `curl`, `wget`, `ping`, `dig`, `host`, `ifconfig`, `ip`, `netstat`, `route` |
| Archives | `tar`, `gzip`, `gunzip`, `zip`, `unzip` |
| Node.js | `node`, `npm`, `npx` |
| Lifo | `lifo` (packages, login, tunnels, cloud), `browser-metro` (Expo web bundler) |
| Familiar names | `supabase`, `expo` (below) |
| On Lifo's servers | `ffmpeg`, `ffprobe` ([Services](../cloud/services.md): native tools, after asking to upload) |
| Packages | `git`, `vi`, `nano`, `less` (in `lifo-sh` and on lifo.sh), and anything from `lifo install` |

`help` lists what a box has; `man <command>` (with `lifo install man`) and `<command> --help`
describe one.

## Commands you know, run the Lifo way

Some CLIs can't run in a box (the Supabase CLI needs Docker, Expo's Metro is too heavy for a
tab), but a drop-in can. Typing the familiar command runs the drop-in, with a one-line 💡 note on
stderr saying so, so tutorials, scripts and coding agents work unchanged:

| You type | It runs | Notes |
|---|---|---|
| `supabase start`, `supabase db reset`, `supabase status` (also `npx supabase ...`) | `npx tinbase ...`: a Supabase-compatible backend (REST, auth, storage, realtime, Studio) on `:54321`, reading the usual `supabase/` folder | uses tinbase's pure-JS pg-mem engine in a box (`TINBASE_ENGINE=pgmem`; no RLS, cron or pgmq). `npx` installs it on first use |
| `expo start [dir] [--port N]` (also `npx expo start`, and `npm start` with `"start": "expo start"`) | `browser-metro`: bundles the Expo app in the box (packages pre-built from esm.reactnative.run) and serves it on `:8081` | web preview with HMR. On a real machine, `npx rnrun start` is the same engine as a drop-in for `expo start` |
| `expo install <pkgs>` | `npm install <pkgs>` | no SDK version pinning |
| `ffmpeg`, `ffprobe` | native ffmpeg 7 on [Lifo services](../cloud/services.md) | needs `lifo login`; asks before uploading the input files; `LIFO_EXEC=local` keeps everything in the box |
| `docker`, `docker-compose` | nothing | a note: run each service directly in the box |

Your own `alias supabase=...` takes precedence. `2>/dev/null` hides the note.
