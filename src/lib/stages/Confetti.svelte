<script lang="ts">
	const COLORS = ['#ef4444', '#f59e0b', '#fde047', '#22c55e', '#3b82f6', '#ec4899', '#ffffff'];
	const PIECES_PER_SIDE = 110;
	const GRAVITY = 1500;
	const DRAG = 0.985;
	const LASTS_MS = 4200;

	function launch(canvas: HTMLCanvasElement) {
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		canvas.width = innerWidth;
		canvas.height = innerHeight;
		const context = canvas.getContext('2d')!;

		// Fired up and inwards from both bottom corners.
		const pieces = [-1, 1].flatMap((side) =>
			Array.from({ length: PIECES_PER_SIDE }, () => {
				const speed = canvas.height * (1.2 + Math.random() * 1.1);
				const angle = Math.PI / 2 + side * (0.15 + Math.random() * 0.65);
				return {
					x: side < 0 ? 0 : canvas.width,
					y: canvas.height,
					vx: Math.cos(angle) * speed,
					vy: -Math.sin(angle) * speed,
					width: 8 + Math.random() * 8,
					height: 12 + Math.random() * 10,
					spin: Math.random() * Math.PI * 2,
					spinSpeed: 5 + Math.random() * 10,
					color: COLORS[Math.floor(Math.random() * COLORS.length)]
				};
			})
		);

		const started = performance.now();
		let last = started;
		let frame = requestAnimationFrame(function draw(now) {
			const seconds = Math.min((now - last) / 1000, 0.05);
			last = now;
			context.clearRect(0, 0, canvas.width, canvas.height);
			const age = now - started;
			if (age > LASTS_MS) return;
			context.globalAlpha = Math.min(1, (LASTS_MS - age) / 800);
			const drag = DRAG ** (seconds * 60);
			for (const p of pieces) {
				p.vy += GRAVITY * seconds;
				p.vx *= drag;
				p.vy *= drag;
				p.x += p.vx * seconds;
				p.y += p.vy * seconds;
				p.spin += p.spinSpeed * seconds;
				context.save();
				context.translate(p.x, p.y);
				context.rotate(p.spin);
				context.scale(Math.cos(p.spin * 1.7), 1);
				context.fillStyle = p.color;
				context.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
				context.restore();
			}
			frame = requestAnimationFrame(draw);
		});
		return () => cancelAnimationFrame(frame);
	}
</script>

<canvas {@attach launch} class="pointer-events-none fixed inset-0 z-[60]" aria-hidden="true"></canvas>
