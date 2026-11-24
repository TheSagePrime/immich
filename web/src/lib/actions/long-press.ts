import type { Attachment } from 'svelte/attachments';

export type LongPressPoint = { x: number; y: number; target: EventTarget | null };

export const LONG_PRESS_DELAY = 500;
const MOVE_TOLERANCE = 10;

export const longPress =
  (onLongPress: (point: LongPressPoint) => void, delay = LONG_PRESS_DELAY): Attachment<HTMLElement> =>
  (node) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start: { x: number; y: number } | undefined;
    let fired = false;

    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
      start = undefined;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') {
        return;
      }

      cancel();
      fired = false;
      start = { x: event.clientX, y: event.clientY };
      const target = event.target;
      timer = setTimeout(() => {
        fired = true;
        timer = undefined;
        onLongPress({ x: start?.x ?? event.clientX, y: start?.y ?? event.clientY, target });
      }, delay);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE) {
        cancel();
      }
    };

    const onClick = (event: MouseEvent) => {
      if (fired) {
        fired = false;
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const onContextMenu = (event: MouseEvent) => {
      if (fired) {
        event.preventDefault();
      }
    };

    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', cancel);
    node.addEventListener('pointercancel', cancel);
    node.addEventListener('click', onClick, { capture: true });
    node.addEventListener('contextmenu', onContextMenu, { capture: true });

    return () => {
      cancel();
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('click', onClick, { capture: true });
      node.removeEventListener('contextmenu', onContextMenu, { capture: true });
    };
  };
