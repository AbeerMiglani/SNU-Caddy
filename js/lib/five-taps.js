// Hidden entry for the driver-phone setup: 5 quick taps on a logo.

/** Call `onOpen` after 5 taps on `el`, each less than 600 ms after the last. */
export function onFiveTaps(el, onOpen) {
  let count = 0;
  let last = 0;
  el.addEventListener('click', (e) => {
    const now = e.timeStamp;
    count = now - last < 600 ? count + 1 : 1;
    last = now;
    if (count >= 5) {
      count = 0;
      onOpen();
    }
  });
}
