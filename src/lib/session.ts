/**
 * Dev only: records every play session to .recordings/sessions, so what the player meant to do can
 * be compared with what the tracking did. Head angles and game events only, never video.
 */
const FLUSH_MS = 3000;
const ENABLED = import.meta.env.DEV && typeof window !== 'undefined';

type Num = number | null | undefined;
const round = (v: Num) => (v == null ? null : Math.round(v * 100) / 100);

class SessionLog {
	readonly id = String(Date.now());
	private lines: string[] = [];
	private started = false;

	start(meta: Record<string, unknown>) {
		if (!ENABLED || this.started) return;
		this.started = true;
		this.event('start', {
			...meta,
			viewport: { width: innerWidth, height: innerHeight },
			screen: { width: screen.width, height: screen.height }
		});
		setInterval(() => this.flush(), FLUSH_MS);
		addEventListener('pagehide', () => this.flush(true));
	}

	event(type: string, data: Record<string, unknown> = {}) {
		if (!ENABLED) return;
		this.lines.push(JSON.stringify({ t: round(performance.now()), e: type, ...data }));
	}

	/** One tracked camera frame. Short keys, because there are 30 of these every second. */
	frame(t: number, yaw: Num, pitch: Num, x: Num, y: Num, headX: Num, headY: Num, held: boolean) {
		if (!ENABLED) return;
		this.lines.push(
			JSON.stringify({
				t: round(t),
				y: round(yaw),
				p: round(pitch),
				x: round(x),
				v: round(y),
				a: round(headX),
				b: round(headY),
				h: held ? 1 : 0
			})
		);
	}

	private flush(leaving = false) {
		if (!this.lines.length) return;
		const body = this.lines.join('\n') + '\n';
		this.lines = [];
		const url = `/__session?id=${this.id}`;
		if (leaving) navigator.sendBeacon(url, body);
		else fetch(url, { method: 'POST', body }).catch(() => {});
	}
}

export const session = new SessionLog();
