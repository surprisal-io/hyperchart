import { useEffect, useRef, type RefObject } from "react";

const modalStack: symbol[] = [];

const FOCUSABLE_SELECTOR = [
	"a[href]",
	'button:not([disabled]):not([tabindex="-1"])',
	'input:not([disabled]):not([type="hidden"])',
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[tabindex]:not([tabindex="-1"])',
].join(",");

export function useModalDialog({
	dialogRef,
	initialFocusRef,
	onClose,
	open = true,
}: {
	dialogRef: RefObject<HTMLElement | null>;
	initialFocusRef?: RefObject<HTMLElement | null>;
	onClose: () => void;
	open?: boolean;
}): void {
	const modalIdRef = useRef(Symbol("hyperchart-modal"));
	const onCloseRef = useRef(onClose);
	useEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	useEffect(() => {
		if (!open || typeof document === "undefined") return undefined;
		const dialog = dialogRef.current;
		if (dialog === null) return undefined;
		const modalId = modalIdRef.current;
		modalStack.push(modalId);
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

		const focusableElements = () =>
			Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
				(element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true",
			);
		(initialFocusRef?.current ?? focusableElements()[0] ?? dialog).focus();

		const onKeyDown = (event: KeyboardEvent) => {
			if (modalStack.at(-1) !== modalId) return;
			if (event.key === "Escape") {
				event.preventDefault();
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = focusableElements();
			if (focusable.length === 0) {
				event.preventDefault();
				dialog.focus();
				return;
			}
			const first = focusable[0];
			const last = focusable.at(-1);
			if (first === undefined || last === undefined) return;
			if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
				event.preventDefault();
				first.focus();
			}
		};

		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			const stackIndex = modalStack.lastIndexOf(modalId);
			const wasTopmost = stackIndex === modalStack.length - 1;
			if (stackIndex !== -1) modalStack.splice(stackIndex, 1);
			if (wasTopmost && previousFocus?.isConnected) previousFocus.focus();
		};
	}, [dialogRef, initialFocusRef, open]);
}
