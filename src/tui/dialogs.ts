/**
 * Dialog open-state tracking. The V2 TUI dialog API exposes no `open` getter,
 * but keymap layers must go quiet while a modal is up (the dialog owns
 * escape/return). Track it ourselves: wrap every dialog call in run().
 */
import { createSignal } from "solid-js";

export interface DialogTracker {
	/** Reactive: is one of OUR dialogs open? */
	open(): boolean;
	/** Run a dialog to completion, tracking open state around the promise. */
	run<T>(fn: () => Promise<T>): Promise<T | undefined>;
}

export function createDialogTracker(): DialogTracker {
	const [open, setOpen] = createSignal(false);
	return {
		open: () => open(),
		async run(fn) {
			setOpen(true);
			try {
				return await fn();
			} finally {
				setOpen(false);
			}
		},
	};
}
