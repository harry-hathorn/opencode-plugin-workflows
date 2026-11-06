/**
 * Dialog open-state tracking. The V2 TUI dialog API exposes no `open` getter,
 * but keymap layers must go quiet while a modal is up (the dialog owns
 * escape/return). Track it ourselves: wrap promise dialogs in run(), and
 * bracket fire-and-forget dialog.show() with begin()/end() (onClose is the
 * natural end point).
 */
import { createSignal } from "solid-js";

export interface DialogTracker {
	/** Reactive: is one of OUR dialogs open? */
	open(): boolean;
	/** Run a promise dialog (confirm/select/prompt) to completion, tracking open state around it. */
	run<T>(fn: () => Promise<T>): Promise<T | undefined>;
	/** Mark a dialog.show() modal as open (call its onClose → end()). */
	begin(): void;
	/** Mark the dialog.show() modal as closed. */
	end(): void;
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
		begin: () => setOpen(true),
		end: () => setOpen(false),
	};
}
