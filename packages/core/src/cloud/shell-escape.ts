/**
 * The ssh-style escape for `lifo cloud shell`: `~.` typed at the start of a line disconnects;
 * `~~` sends one `~`. Everything else passes through. Feed it keystrokes as they come.
 */
export function createShellEscape(): (data: string) => { send: string; disconnect: boolean } {
	let lineStart = true;
	let tilde = false;
	return (data) => {
		let send = '';
		for (const ch of data) {
			if (tilde) {
				tilde = false;
				if (ch === '.') return { send, disconnect: true };
				send += ch === '~' ? '~' : `~${ch}`;
			} else if (lineStart && ch === '~') {
				tilde = true;
				continue;
			} else send += ch;
			lineStart = ch === '\r' || ch === '\n';
		}
		return { send, disconnect: false };
	};
}
