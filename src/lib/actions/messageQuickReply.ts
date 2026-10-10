// Quick reply gestures for thread messages: touch swipe toward the inline end
// (right in LTR, left in RTL) and, in Shell, mouse double-click. Both only
// shortcut the existing Reply action; the action menu stays the primary path.
export const SWIPE_REPLY_SLOP = 10;
export const SWIPE_REPLY_THRESHOLD = 56;
export const SWIPE_REPLY_MAX_OFFSET = 72;
const SWIPE_REPLY_EDGE = 20;
const SWIPE_REPLY_SETTLE_MS = 200;

// Interactive content keeps its own click, double-click and touch behavior.
const QUICK_REPLY_IGNORED =
  'a, button, input, textarea, select, label, video, audio, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="dialog"]';

export function isQuickReplyIgnoredTarget(target: EventTarget | null) {
  return !(target instanceof Element) || Boolean(target.closest(QUICK_REPLY_IGNORED));
}

// `forward` is the distance along the reply direction, `cross` the vertical one.
export function classifySwipe(forward: number, cross: number): 'pending' | 'swipe' | 'ignore' {
  if (Math.hypot(forward, cross) < SWIPE_REPLY_SLOP) return 'pending';
  return forward > Math.abs(cross) * 1.5 ? 'swipe' : 'ignore';
}

export function swipeOffset(forward: number) {
  if (forward <= 0) return 0;
  if (forward <= SWIPE_REPLY_THRESHOLD) return forward;
  return Math.min(
    SWIPE_REPLY_MAX_OFFSET,
    SWIPE_REPLY_THRESHOLD + (forward - SWIPE_REPLY_THRESHOLD) * 0.3,
  );
}

export function swipeArmed(forward: number) {
  return forward >= SWIPE_REPLY_THRESHOLD;
}

interface MessageSwipeReplyOptions {
  disabled: boolean;
  onreply: () => void;
}

export function messageSwipeReply(node: HTMLElement, options: MessageSwipeReplyOptions) {
  let gesture: {
    id: number;
    x: number;
    y: number;
    sign: 1 | -1;
    locked: boolean;
    armed: boolean;
  } | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  function swallowClick(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
  }
  function clearVisual() {
    node.classList.remove('swipe-reply-active', 'swipe-reply-dragging', 'swipe-reply-armed');
    node.style.removeProperty('--swipe-reply-offset');
    node.style.removeProperty('--swipe-reply-progress');
  }
  function release() {
    gesture = null;
    removeEventListener('pointerdown', otherPointer, true);
  }
  // A second finger anywhere (pinch, two-finger scroll) cancels the swipe.
  function otherPointer(event: PointerEvent) {
    if (gesture && event.pointerId !== gesture.id) finish(false);
  }
  function finish(reply: boolean) {
    const current = gesture;
    release();
    if (!current?.locked) return;
    if (node.hasPointerCapture?.(current.id)) node.releasePointerCapture(current.id);
    // A drag is not a tap: drop the click some browsers fire on release.
    clearTimeout(clickTimer);
    node.removeEventListener('click', swallowClick, true);
    node.addEventListener('click', swallowClick, { capture: true, once: true });
    clickTimer = setTimeout(() => node.removeEventListener('click', swallowClick, true), 400);
    node.classList.remove('swipe-reply-dragging', 'swipe-reply-armed');
    node.style.setProperty('--swipe-reply-offset', '0px');
    node.style.setProperty('--swipe-reply-progress', '0');
    settleTimer = setTimeout(clearVisual, SWIPE_REPLY_SETTLE_MS);
    if (reply && current.armed) options.onreply();
  }
  function down(event: PointerEvent) {
    if (gesture) return;
    if (
      event.pointerType !== 'touch' ||
      !event.isPrimary ||
      options.disabled ||
      isQuickReplyIgnoredTarget(event.target)
    )
      return;
    const sign = getComputedStyle(node).direction === 'rtl' ? -1 : 1;
    // Leave the screen edge to system back-navigation gestures.
    if (sign > 0 ? event.clientX < SWIPE_REPLY_EDGE : event.clientX > innerWidth - SWIPE_REPLY_EDGE)
      return;
    gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      sign,
      locked: false,
      armed: false,
    };
    addEventListener('pointerdown', otherPointer, true);
  }
  function move(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const forward = (event.clientX - gesture.x) * gesture.sign;
    if (!gesture.locked) {
      const axis = classifySwipe(forward, event.clientY - gesture.y);
      if (axis === 'pending') return;
      if (axis === 'ignore') {
        release();
        return;
      }
      // messagePress already cancelled the long press past its 8px slop.
      gesture.locked = true;
      try {
        node.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic or already released pointers cannot be captured.
      }
      clearTimeout(settleTimer);
      node.classList.add('swipe-reply-active', 'swipe-reply-dragging');
    }
    gesture.armed = swipeArmed(forward);
    node.style.setProperty('--swipe-reply-offset', `${swipeOffset(forward) * gesture.sign}px`);
    node.style.setProperty(
      '--swipe-reply-progress',
      String(Math.min(1, Math.max(0, forward) / SWIPE_REPLY_THRESHOLD)),
    );
    node.classList.toggle('swipe-reply-armed', gesture.armed);
  }
  const up = (event: PointerEvent) => {
    if (gesture && event.pointerId === gesture.id) finish(true);
  };
  const cancel = (event: PointerEvent) => {
    if (gesture && event.pointerId === gesture.id) finish(false);
  };
  // Touch pointers start implicitly captured by the touched descendant (text,
  // bubble). Capturing on the row fires a bubbling lostpointercapture for that
  // descendant; only losing the row's own capture ends the swipe.
  const lostCapture = (event: PointerEvent) => {
    if (event.target === node) cancel(event);
  };
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('lostpointercapture', lostCapture);
  return {
    update(next: MessageSwipeReplyOptions) {
      options = next;
      if (next.disabled && gesture) finish(false);
    },
    destroy() {
      release();
      clearTimeout(settleTimer);
      clearTimeout(clickTimer);
      clearVisual();
      node.removeEventListener('click', swallowClick, true);
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('lostpointercapture', lostCapture);
    },
  };
}
