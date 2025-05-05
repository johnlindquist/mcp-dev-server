export class LogRingBuffer<T> {
	private buffer: T[];
	private capacity: number;
	private start: number;
	private count: number;

	constructor(capacity: number) {
		this.capacity = capacity;
		this.buffer = new Array(capacity);
		this.start = 0;
		this.count = 0;
	}

	push(item: T) {
		if (this.count < this.capacity) {
			this.buffer[(this.start + this.count) % this.capacity] = item;
			this.count++;
		} else {
			this.buffer[this.start] = item;
			this.start = (this.start + 1) % this.capacity;
		}
	}

	toArray(): T[] {
		const arr: T[] = [];
		for (let i = 0; i < this.count; i++) {
			arr.push(this.buffer[(this.start + i) % this.capacity]);
		}
		return arr;
	}

	get length() {
		return this.count;
	}
}
