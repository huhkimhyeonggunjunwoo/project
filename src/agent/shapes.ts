/**
 * Starting silhouettes for the eyes, traced from the reference design
 * (a 1458×936 frame). The eye reads this outline at a few control points,
 * rounds it off, and then keeps those points drifting — so this sets the
 * overall size, placement and character, not the exact on-screen shape.
 * Coordinates are in the reference frame's units and are rescaled to fit
 * the viewport, so they can be swapped for paths exported from Figma.
 */
export const REFERENCE_FRAME = { width: 1458, height: 936 };

export interface EyeShape {
  path: string;
  /** -1 for the eye on the left of the screen, 1 for the right. */
  side: -1 | 1;
}

export const LEFT_EYE: EyeShape = {
  side: -1,
  path: `
    M 494 327
    C 540 329, 622 339, 629 364
    C 634 382, 598 412, 540 432
    C 520 439, 500 444, 491 445
    C 478 446, 452 420, 440 373
    C 435 349, 449 329, 494 327 Z`,
};

export const RIGHT_EYE: EyeShape = {
  side: 1,
  path: `
    M 840 328
    C 900 323, 990 318, 1012 327
    C 1025 333, 1020 352, 1007 369
    C 990 393, 956 430, 918 442
    C 885 453, 845 448, 778 421
    C 755 410, 748 380, 754 360
    C 758 343, 770 333, 840 328 Z`,
};
