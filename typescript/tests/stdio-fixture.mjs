// Synthetic protocol peer only. No filesystem, network, OS permission or GPUI access.
import { createInterface } from 'node:readline';
const mode = process.argv[2];
const session = process.argv[3];
let count = 0,
	revision = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
	const request = JSON.parse(line),
		{ method } = request.command;
	if (mode === 'hang' && method !== 'close') return;
	if (mode === 'oversize' && method !== 'close') {
		process.stdout.write('x'.repeat(1048577));
		return;
	}
	let result = {};
	if (method === 'observe')
		result = {
			protocol: 1,
			session,
			revision: ++revision,
			surface: {
				ready: true,
				title: 'Mock',
				facts: { count },
				controls: [
					{
						id: 'increment',
						label: 'Increment',
						role: 'button',
						value: '',
						enabled: true,
						selected: false,
						actions: ['click'],
						bounds: { x: 0, y: 0, width: 10, height: 10 }
					}
				]
			}
		};
	if (method === 'verify')
		result = {
			passed: count === 2,
			credentialPresent: Boolean(process.env.TYPESAFE_API_KEY || process.env.UNRELATED_TEST_SECRET)
		};
	if (method === 'act') {
		count++;
		result = { executed: mode !== 'uncertain' };
	}
	process.stdout.write(
		JSON.stringify({
			protocol: 1,
			id: mode === 'wrong-id' ? request.id + 1 : request.id,
			ok: true,
			result
		}) + '\n'
	);
	if (method === 'close') process.exit(0);
});
